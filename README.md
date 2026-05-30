# ormai

Give an LLM agent access to your database. Control exactly what it can see and do.

ormai sits between your agent and your ORM. It reads your schema, you write access policies, it generates the tools. The LLM never touches SQL — it only calls what you've explicitly allowed, filtered down to what the current user is permitted to see.

It's **ORM-agnostic** (Prisma is the built-in adapter today; the adapter contract is small enough to wrap any ORM — see [Other ORMs](#other-orms)) and **provider-agnostic** — the same tools come out shaped for Anthropic, OpenAI, Google Gemini, or the Vercel AI SDK (see [Tool formats](#tool-formats--providers)).

```ts
const ormai = new ORMAI<DefaultContext, InferResources<typeof prisma>>({
  adapter: new PrismaAdapter(prisma, "./prisma/schema.prisma"),
  defaultPolicy: "deny-all",
})

ormai.policy("order", (ctx) => ({
  read: { tenant_id: ctx.tenant.id },   // row-level filter, always injected
  write: { tenant_id: ctx.tenant.id },  // forced into data, guards updates too
  delete: false,
  fields: {
    deny: ctx.user.role === "support" ? ["user_id"] : [],
  },
  relations: {
    customer: ctx.user.role === "admin",
    items: true,
  },
}))

const tools = await ormai.executableTools(ctx)
// hand `tools` to your LLM framework of choice
```

---

## How it works

1. **Introspection** — on first call, ormai parses your `schema.prisma` using `@prisma/internals`. No DB connection needed.
2. **Policy evaluation** — for the current request context, it evaluates each resource policy and determines which operations, fields, and relations are accessible.
3. **Tool generation** — it generates provider-neutral JSON Schema tool definitions shaped by the evaluated policy, then formats them for your LLM provider (Anthropic, OpenAI, Gemini, Vercel AI SDK, or a custom formatter). A resource with `read: false` produces no tools at all.
4. **Execution** — when the LLM calls a tool, ormai validates the input, re-evaluates policy, builds an IR with policy filters already merged, and executes via the adapter. The LLM cannot produce a query that escapes the policy filters.

---

## Installation

```bash
npm install ormai @prisma/client
npm install -D @prisma/internals
```

ormai requires Prisma 5+.

---

## Setup

```ts
import { ORMAI, PrismaAdapter, InferResources } from "ormai"
import type { DefaultContext } from "ormai"
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

const ormai = new ORMAI<DefaultContext, InferResources<typeof prisma>>({
  adapter: new PrismaAdapter(prisma, "./prisma/schema.prisma"),
  defaultPolicy: "deny-all",
})
```

`InferResources<typeof prisma>` is a type-level transform that converts your Prisma client's model keys (`orderItem`) to ormai resource names (`order_item`). It gives you autocomplete and type errors on policy keys — no manual type declarations needed.

---

## Policies

A policy function receives the current context and returns what's allowed for that resource:

```ts
ormai.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },  // WHERE clause always injected
  write:  { tenant_id: ctx.tenant.id },  // forced into INSERT/UPDATE data
  delete: false,
  fields: {
    deny: ["internal_notes"],            // never sent to LLM
  },
  relations: {
    items:    true,
    customer: ctx.user.role === "admin", // support users can't include customer data
  },
}))
```

**`read`, `write`, `delete`** accept:
- `true` — allow
- `false` — deny (no tools generated for this operation)
- `{ field: value }` — for `read`/`delete`: row-level WHERE filter; for `write`: forced fields merged into data AND used as a WHERE guard on updates

The policy filter is always AND-ed with whatever the LLM requests. It can't be overridden.

**Fields** marked `@ormai:sensitive` in the schema are excluded from all tools and query results regardless of what the policy says.

### Wildcard policy

For resources you want to cover without individual policies:

```ts
ormai.policy("*", (ctx) => ({
  read: { tenant_id: ctx.tenant.id },
  write: false,
  delete: false,
}))
```

Or use `resolvePolicy` in the config for more control:

```ts
new ORMAI({
  // ...
  resolvePolicy: (resource, ctx) => ({
    read: { tenant_id: ctx.tenant.id },
    write: false,
    delete: false,
  }),
})
```

---

## Tool formats / providers

`ormai.tools.<provider>(ctx)` returns the tools formatted for that provider. Each entry is `{ definition, name, execute }`:

- `definition` — the clean, provider-specific shape to hand to the model API
- `name` — the tool name, for matching a tool call back to its handler
- `execute(args)` — runs the call with policy enforced and results serialized (`Decimal` → number, `Date` → ISO string, `BigInt` → string)

Built-in providers: `anthropic`, `openai`, `gemini`, `vercel`.

**OpenAI:**
```ts
const tools = await ormai.tools.openai(ctx)

const res = await openai.chat.completions.create({
  model: "gpt-4o",
  messages,
  tools: tools.map(t => t.definition),   // { type: "function", function: {...} }
})

// on a tool call:
for (const call of res.choices[0].message.tool_calls ?? []) {
  const handler = tools.find(t => t.name === call.function.name)
  const result = await handler?.execute(JSON.parse(call.function.arguments))
}
```

**Anthropic:**
```ts
const tools = await ormai.tools.anthropic(ctx)

const res = await anthropic.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 1024,
  messages,
  tools: tools.map(t => t.definition),   // { name, description, input_schema }
})

// on a tool_use block:
const result = await tools.find(t => t.name === block.name)?.execute(block.input)
```

**Google Gemini:** `t.definition` is a function declaration — wrap the list in `{ functionDeclarations: [...] }`.

**Vercel AI SDK:** `t.definition` is `{ description, parameters }`; wrap `parameters` with `jsonSchema()` and attach `execute`:
```ts
import { tool, jsonSchema } from "ai"

const ormaiTools = await ormai.tools.vercel(ctx)
const tools = Object.fromEntries(
  ormaiTools.map(t => [
    t.name,
    tool({
      description: t.definition.description,
      parameters: jsonSchema(t.definition.parameters),
      execute: async (args) => {
        try { return await t.execute(args) }
        catch (err) { return { error: err.message } }
      },
    }),
  ])
)
```

**Any other provider** — pass a formatter to `ormai.tools.format(ctx, fn)`:
```ts
const tools = await ormai.tools.format(ctx, (t) => ({
  name: t.name,
  description: t.description,
  schema: t.parameters,   // t is a NeutralTool { name, description, parameters }
}))
```

> The original flat helpers are still available: `ormai.getTools(ctx)` (Anthropic `input_schema` shape) and `ormai.executableTools(ctx)` (the same, with `execute()` attached).

---

## Schema annotations

Annotate your Prisma schema with `///` doc comments to give the LLM better descriptions:

```prisma
/// @ormai:description "A customer purchase order"
model Order {
  id     String      @id @default(uuid())
  status OrderStatus

  /// @ormai:description "Order total in cents"
  total  Decimal

  /// @ormai:sensitive
  internal_notes String?   // never exposed to LLM, regardless of policy
}
```

---

## Generated tools

For each resource, ormai generates up to six tools depending on what the policy allows:

| Tool | Operation |
|---|---|
| `query_{resource}` | findMany with filters, sort, pagination, includes |
| `get_{resource}` | findOne by id |
| `create_{resource}` | insert one row |
| `update_{resource}` | update by id |
| `delete_{resource}` | delete by id |
| `aggregate_{resource}` | count/sum/avg/min/max with optional groupBy |

Fields with database defaults (`@default(now())`, `@default(uuid())`) are not required in create tools. The LLM doesn't need to supply them.

---

## Observability

```ts
const ormai = new ORMAI({
  // ...
  onQuery: ({ toolName, resource, operation, ctx, durationMs, error }) => {
    logger.info({ toolName, resource, operation, durationMs, userId: ctx.user.id })
    if (error) logger.error({ toolName, error: error.message })
  },
})
```

---

## Discovering resource names

Resource names are derived from Prisma model names: `PascalCase` → `singular_snake_case` (`OrderItem` → `order_item`). If you typo a policy key, ormai warns you at runtime with the list of valid names.

To see all resources and their fields programmatically:

```ts
const info = await ormai.describe()
// Returns: name, fields, relations, and a ready-to-paste policy stub for each resource
```

---

## Security properties

- The LLM never sees the raw schema or constructs queries directly
- Policy row filters are merged server-side and cannot be overridden by the LLM
- `update` and `delete` use `updateMany`/`deleteMany` with the full policy filter in the WHERE clause — guessing an ID from another tenant does nothing
- `write: { tenant_id }` forces the value into created/updated data — the LLM can't write to a different tenant even if it tries
- `belongsTo` includes enforce the related resource's row filter post-fetch
- Sensitive fields are stripped at introspection time, before policy evaluation

---

## Other ORMs

Prisma is the only built-in adapter today, but ormai is not tied to it. Everything above the adapter — policies, tool generation, the query IR, serialization — is ORM-agnostic. An adapter is just two methods:

```ts
import type { ORMAIAdapter, SchemaMap, ResolvedQuery } from "ormai"

class MyOrmAdapter implements ORMAIAdapter {
  // Describe your schema as resources, fields, and relations.
  async introspect(): Promise<SchemaMap> { /* ... */ }

  // Run a resolved, policy-checked query. Filters are already merged in.
  async execute(query: ResolvedQuery): Promise<unknown> { /* ... */ }
}

const ormai = new ORMAI({ adapter: new MyOrmAdapter() })
```

`SchemaMap`, `ResolvedQuery`, and `FilterNode` are all exported so an adapter can map ormai's neutral query into its own ORM's calls. The `PrismaAdapter` in [`src/adapters/prisma.ts`](src/adapters/prisma.ts) is a reference implementation.

---

## Example

See [`examples/ecommerce/`](examples/ecommerce/) for a full working demo: three users (admin, support, cross-tenant) asking the same question, getting back different data based on their context.

---

## License

MIT
