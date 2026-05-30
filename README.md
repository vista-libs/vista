# ormai

**The authorization layer for AI agents.**

Give your LLM agent access to your database. Control exactly what it can see and do.

ormai reads your ORM schema, generates typed tools the model can call, and enforces access control server-side — on every query, regardless of what the model was told to do.

```ts
const tools = await ormai.tools.vercel(ctx)
await generateText({ model, tools, maxSteps: 5, prompt })
```

The agent sees only what the current user is allowed to see. No SQL generation. No prompt-based permissions. No per-endpoint wrappers.

---

## The problem

Most agents reach your data through one of these:

```
LLM → SQL          LLM → ORM          LLM → API endpoints
```

…and authorization usually lives in the prompt:

> "Only return data for the current tenant."

That holds right up until the model ignores the instruction, a prompt injection lands, a tool is misconfigured, or someone forgets a filter. A prompt is not a security boundary. One slip leaks customer data.

## The solution

With ormai, permissions live in code — not prompts.

```ts
ormai.policy("order", (ctx) => ({
  read: { tenant_id: ctx.tenant.id },
}))
```

That filter is AND-ed into every read, server-side, after the tool call is parsed. The model cannot widen it, override it, or talk its way around it — the filtered query is the only query that runs.

---

## Same prompt. Same agent. Different context

```
"Summarize all orders. For each delivered order, show the items purchased."
```

| | Alice · admin | Bob · support | Carol · admin, tenant-β |
|---|---|---|---|
| **Tools visible** | query, get, create, update, aggregate | query, get, aggregate | query, get, create, update, aggregate |
| **Row filter** | `tenant_id = alpha` | `tenant_id = alpha` | `tenant_id = beta` |
| **Hidden fields** | — | `user_id` | — |
| **Customer relation** | ✓ | ✗ blocked | ✓ |
| **Orders returned** | #1, #3 | #1, #3 | #5, #6 |

Alice gets full output. Bob gets no customer link and `user_id` stripped. Carol only sees her tenant — `tenant-alpha` orders are structurally invisible to her. All from one policy function, no branching in your prompt.

---

## The policy

```ts
import { ORMAI } from "ormai"
import { PrismaAdapter } from "@ormai/prisma"

const ormai = new ORMAI<Ctx, InferResources<typeof prisma>>({
  adapter: new PrismaAdapter(prisma, "./prisma/schema.prisma"),
  defaultPolicy: "deny-all",
})

ormai.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },  // row filter — AND-ed into every read
  write:  { tenant_id: ctx.tenant.id },  // force-injected on INSERT, guards UPDATE WHERE
  delete: false,                          // delete_order tool never generated
  fields:    { deny: ctx.user.role === "support" ? ["user_id"] : [] },
  relations: { customer: ctx.user.role === "admin", items: true },
}))
```

That policy produces exactly these tools:

```
admin                              support
────────────────────────────────   ────────────────────────────────
query_order   ← tenant filter      query_order   ← tenant filter
get_order     ← tenant filter      get_order     ← tenant filter
create_order  ← tenant injected    create_order  ← tenant injected
update_order  ← tenant guard       update_order  ← tenant guard
aggregate_order                    aggregate_order
                                   ↳ user_id stripped from results
                    ✗ delete_order not generated for either
```

Connect to your agent in one line:

```ts
const tools = await ormai.tools.vercel(ctx)
const { text } = await generateText({ model, tools, maxSteps: 8, prompt })
```

---

## How it works

```
LLM
 ↓   tool call (no SQL, just arguments)
ormai policy engine        ← row filters, write injection, field stripping, tool suppression
 ↓
your ORM
 ↓
database
```

The model never writes a query. It calls a typed tool with arguments; ormai resolves that into an ORM operation, applies the policy *before* execution, and runs it. Enforcement happens on the server, in your process — not in the prompt and not on the model's honor.

---

## Installation

```bash
npm install ormai @ormai/prisma
```

| Package | Contents |
|---|---|
| `ormai` | Zero-dependency core — policies, tool generation, IR |
| `@ormai/prisma` | Prisma adapter + schema introspection (requires Prisma 5+) |
| `ai` | Optional — only needed for `ormai.tools.vercel()` |

---

## Setup

```ts
import { ORMAI } from "ormai"
import { PrismaAdapter } from "@ormai/prisma"
import type { DefaultContext, InferResources } from "ormai"

const prisma = new PrismaClient()

const ormai = new ORMAI<DefaultContext, InferResources<typeof prisma>>({
  adapter: new PrismaAdapter(prisma, "./prisma/schema.prisma"),
  defaultPolicy: "deny-all",
})
```

`InferResources<typeof prisma>` converts Prisma model keys (`orderItem`) to ormai resource names (`order_item`). Policy keys are type-checked — a typo is a compile error.

---

## Schema annotations

Use `///` doc comments to give the LLM better context and mark fields that must never leave the server:

```prisma
/// @ormai:description "A customer purchase order"
model Order {
  id     String @id @default(uuid())
  status OrderStatus

  /// @ormai:description "Order total in cents"
  total  Decimal

  /// @ormai:sensitive
  internal_notes String?  // stripped at introspection — never in schemas, args, or results
}
```

`@ormai:sensitive` is enforced before policy runs. The field doesn't exist as far as the LLM is concerned.

---

## Policies

```ts
// Everything defaults to the tenant scope
ormai.policy("*", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  { tenant_id: ctx.tenant.id },
  delete: false,
}))

// Per-resource: override and extend
ormai.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  { tenant_id: ctx.tenant.id },
  delete: false,
  fields:    { deny: ctx.user.role === "support" ? ["user_id"] : [] },
  relations: { customer: ctx.user.role === "admin", items: true },
}))
```

`read`, `write`, and `delete` accept:

| Value | Meaning |
|---|---|
| `true` | allow |
| `false` | deny — no tool generated |
| `{ field: value }` | `read`/`delete`: WHERE always AND-ed in · `write`: force-injected on INSERT, AND-ed on UPDATE/DELETE WHERE |

---

## Generated tools

For each resource, ormai generates up to six tools based on what the policy allows:

| Tool | Operation |
|---|---|
| `query_{resource}` | findMany with filters, sort, pagination, relation includes |
| `get_{resource}` | findOne by id |
| `create_{resource}` | insert one row |
| `update_{resource}` | update by id |
| `delete_{resource}` | delete by id |
| `aggregate_{resource}` | count / sum / avg / min / max with optional groupBy |

`delete: false` → no `delete_` tool. A required write field denied and not force-injected → `create_` suppressed entirely, not silently broken. Fields with `@default(...)` are not required in create tools.

---

## Providers

| Method | Use with |
|---|---|
| `ormai.tools.vercel(ctx)` | Vercel AI SDK — drops straight into `generateText` / `streamText` |
| `ormai.tools.anthropic(ctx)` | Anthropic Messages API |
| `ormai.tools.openai(ctx)` | OpenAI / any OpenAI-compatible API |
| `ormai.tools.gemini(ctx)` | Google Gemini |
| `ormai.tools.format(ctx, fn)` | Any other provider — pass your own formatter |

```ts
// OpenAI
const tools = await ormai.tools.openai(ctx)

await openai.responses.create({
  model: "gpt-5",
  tools,
  input: "Show this customer's recent orders",
})

// Vercel AI SDK
const tools = await ormai.tools.vercel(ctx)
await generateText({ model, tools, maxSteps: 5, prompt })

// Anthropic
const tools = await ormai.tools.anthropic(ctx)
await anthropic.messages.create({ tools: tools.map(t => t.definition) })
const result = await tools.find(t => t.name === block.name)!.execute(block.input)

// Custom provider
const tools = await ormai.tools.format(ctx, (t) => ({ id: t.name, schema: t.parameters }))
```

Tool errors are caught and returned as `{ error }` so the agent can recover rather than abort.

---

## Observability

```ts
new ORMAI({
  onQuery: ({ toolName, resource, durationMs, error }) => {
    logger.info({ toolName, resource, durationMs })
    if (error) logger.error({ toolName, error: error.message })
  },
})
```

---

## Security properties

| Property | Guarantee |
|---|---|
| Row filters | AND-ed server-side into every query — the LLM can send conflicting filters, they get overwritten |
| Write fields | `write: { tenant_id }` is injected into INSERT data and AND-ed into UPDATE/DELETE WHERE — no argument bypasses it |
| Tool suppression | `false` on any operation → no tool generated, nothing to call |
| Sensitive fields | Stripped at introspection, before policy runs — never in schemas, args, or results |
| Relation joins | `belongsTo` results enforce the related record's row filter post-fetch |
| Broken creates | If a required write field is denied and not force-injected, `create_` is suppressed, not silently broken |

---

## Other adapters

`@ormai/prisma` is the first adapter. Everything above it — policies, tool generation, the query IR — is ORM-agnostic. An adapter is two methods:

```ts
import type { ORMAIAdapter, SchemaMap, ResolvedQuery } from "ormai"

class MyAdapter implements ORMAIAdapter {
  async introspect(): Promise<SchemaMap> { ... }
  async execute(query: ResolvedQuery): Promise<unknown> { ... }
}
```

`SchemaMap`, `ResolvedQuery`, and `FilterNode` are all exported from `ormai`.

---

## Example

[`examples/ecommerce/`](examples/ecommerce/) — a full working demo with three users (admin, support, cross-tenant) issuing the same prompts against a live Postgres database. Includes a stress-test suite verifying tenant isolation, sensitive field exclusion, write policy enforcement, and role-based field denial.

---

## License

MIT
