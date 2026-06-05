# vistal

**Connect your agent to your database. No SQL. No leaks.**

[![npm](https://img.shields.io/npm/v/@vistal/core?label=%40vistal%2Fcore)](https://www.npmjs.com/package/@vistal/core) [![npm](https://img.shields.io/npm/v/@vistal/prisma?label=%40vistal%2Fprisma)](https://www.npmjs.com/package/@vistal/prisma) [![license](https://img.shields.io/npm/l/@vistal/core)](./LICENSE) [![TypeScript](https://img.shields.io/badge/types-TypeScript-blue)](./packages/core)

Three lines wire your agent to your data. The model never writes SQL, never sees a field you hid, and never reads a row the current user isn't allowed to read. Enforcement lives in code, not in the prompt.

```ts
const vistal = createVistal(prisma, { defaultPolicy: "deny-all" })
const tools = await vistal.tools.vercel(ctx)
await generateText({ model, tools, prompt })
```

That's it. No SQL generation. No per-endpoint wrappers. No "please only return the current tenant" in your system prompt.

## Three lines, three guarantees

The whole library is three ideas. Learn these and you know vistal.

### 1. Connect

`createVistal` reads your ORM schema and generates a typed tool per operation per resource: `query_`, `get_`, `create_`, `update_`, `delete_`, `aggregate_`. Hand them to any provider and the agent can work your data through structured tool calls instead of raw SQL.

```ts
import { PrismaClient } from "@prisma/client"
import { createVistal } from "@vistal/prisma"

const vistal = createVistal(new PrismaClient(), { defaultPolicy: "deny-all" })
```

Resource types are inferred from your Prisma client, so a typo in a policy key is a compile error.

### 2. Declare your schema

Annotate your Prisma schema with `///` doc comments. Describe resources so the model uses them correctly, and mark fields that must never leave the server.

```prisma
/// @vistal:description "A customer purchase order"
model Order {
  id     String @id @default(uuid())
  status OrderStatus

  /// @vistal:description "Order total in cents"
  total  Decimal

  /// @vistal:sensitive
  internal_notes String?
}
```

`@vistal:sensitive` is stripped at introspection, before any policy runs. The field does not exist as far as the LLM is concerned: not in schemas, not in arguments, not in results.

### 3. Write typed policies

One typed function decides what each user can touch. Row filters, field visibility, relation access, and which tools exist at all, driven entirely by your runtime context.

```ts
vistal.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },  // AND-ed into every read
  write:  { tenant_id: ctx.tenant.id },  // injected on create, guards update
  delete: false,                          // delete_order tool never generated
  fields:    { deny: ctx.user.role === "support" ? ["user_id"] : [] },
  relations: { customer: ctx.user.role === "admin", items: true },
}))
```

The read filter is AND-ed into the WHERE clause server-side, after the tool call is parsed. The model can send a conflicting filter and it gets overwritten. It cannot widen the filter, override it, or talk its way around it. The scoped query is the only query that runs.

## Same prompt. Same agent. Different context

```
"Summarize all orders. For each delivered order, show the items purchased."
```

| | Alice · admin | Bob · support | Carol · admin, tenant-β |
|---|---|---|---|
| **Tools visible** | query, get, create, update, aggregate | query, get, aggregate | query, get, create, update, aggregate |
| **Row filter** | `tenant_id = alpha` | `tenant_id = alpha` | `tenant_id = beta` |
| **Hidden fields** | none | `user_id` | none |
| **Customer relation** | ✓ | ✗ blocked | ✓ |
| **Orders returned** | #1, #3 | #1, #3 | #5, #6 |

Alice gets full output. Bob gets no customer link and `user_id` stripped. Carol only sees her tenant; `tenant-alpha` orders are structurally invisible to her. One policy function, no branching in your prompt.

## How it works

```
LLM
 ↓   tool call (no SQL, just arguments)
vistal policy engine     ← row filters, write injection, field stripping, tool suppression
 ↓
your ORM
 ↓
database
```

The model calls a typed tool with arguments. vistal resolves it into an ORM operation, applies the policy before execution, and runs it. Enforcement happens in your process, on the server, not on the model's honor.

## Install

```bash
npm install @vistal/core @vistal/prisma
```

| Package | Contents |
|---|---|
| `@vistal/core` | Zero-dependency core: policies, tool generation, query IR |
| `@vistal/prisma` | Prisma adapter + schema introspection (Prisma 5+) |
| `ai` | Optional, only for `vistal.tools.vercel()` |

Pass `schemaPath` to `createVistal` if your schema isn't at `./prisma/schema.prisma`.

## Policy reference

### Operation keys

| Key | Covers | Falls back to |
|---|---|---|
| `read` | `query` / `get` | nothing |
| `aggregate` | `aggregate` | `read` |
| `write` | `create` **and** `update` (shorthand) | nothing |
| `create` | inserts | `write` |
| `update` | updates | `write` |
| `delete` | deletes | nothing |

Split `write` into `create` / `update` when they differ, e.g. allow inserts but make records immutable (`create: true, update: false`), or allow analytics without row reads (`read: false, aggregate: true`).

```ts
// Default everything to tenant scope
vistal.policy("*", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  { tenant_id: ctx.tenant.id },
  delete: false,
}))
```

### Rule values

| Value | Meaning |
|---|---|
| `true` | allow |
| `false` | deny, no tool generated |
| predicate object | a row condition |

Predicates use the same operator vocabulary the LLM filter schema exposes, plus `OR` / `AND` / `NOT`:

```ts
vistal.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id, total: { lt: 100_000 } },
  update: { OR: [{ user_id: ctx.user.id }, { shared: true }] },
}))
```

- **read / delete / aggregate**: the predicate is AND-ed into the WHERE clause.
- **write (create / update)**: scalar equalities (`tenant_id: x`) are force-injected into the row; the full predicate guards the UPDATE/DELETE WHERE so only matching rows are touched. An operator filter on a *required* create field is rejected at build time, since an insert can't satisfy it.

### Field rules

| Key | Effect |
|---|---|
| `allow` | whitelist (read + write) |
| `deny` | blacklist (read + write) |
| `readOnly` | readable, never writable (e.g. `id`, `created_at`) |
| `writeOnly` | writable, never returned (e.g. a settable secret) |

`@vistal:sensitive` fields are stripped regardless.

## Generated tools

| Tool | Operation |
|---|---|
| `query_{resource}` | findMany with filters, sort, pagination, relation includes |
| `get_{resource}` | findOne by id |
| `create_{resource}` | insert one row |
| `update_{resource}` | update by id |
| `delete_{resource}` | delete by id |
| `aggregate_{resource}` | count / sum / avg / min / max with optional groupBy |

`delete: false` suppresses the `delete_` tool. A required write field that is denied and not force-injected suppresses `create_` entirely, rather than generating a tool that always fails. Fields with `@default(...)` are not required in create tools.

## Pagination

`query_` tools return an envelope:

```ts
{ data: [...], nextCursor?: string, hasMore: boolean }
```

Pass `nextCursor` back as the `cursor` argument to fetch the next page — nothing else is required. Cursors are opaque base64 keyset tokens (sort field + direction + value + primary key), so they carry their own sort and paging stays stable under any sort even as rows are inserted. When `hasMore` is `false`, `nextCursor` is omitted.

```ts
const vistal = createVistal(prisma, {
  maxLimit: 100,      // hard cap on `limit` (default 100)
  defaultLimit: 50,   // applied when the model omits `limit` (default 50)
})
```

Omitting `limit` applies `defaultLimit` rather than returning every row. A supplied `limit` is clamped to `maxLimit`. `cursor` takes precedence over `offset`. When no sort is given it defaults to the primary key; a `cursor` reuses the sort it was issued under (resending a *different* sort alongside a cursor is rejected). Cursor pagination requires a non-nullable sort field.

## Providers

| Method | Use with |
|---|---|
| `vistal.tools.vercel(ctx)` | Vercel AI SDK, drops into `generateText` / `streamText` |
| `vistal.tools.anthropic(ctx)` | Anthropic Messages API |
| `vistal.tools.openai(ctx)` | OpenAI / any OpenAI-compatible API |
| `vistal.tools.gemini(ctx)` | Google Gemini |
| `vistal.tools.format(ctx, fn)` | Any other provider, pass your own formatter |

```ts
// OpenAI
const tools = await vistal.tools.openai(ctx)
await openai.responses.create({ model: "gpt-5", tools, input: prompt })

// Anthropic
const tools = await vistal.tools.anthropic(ctx)
await anthropic.messages.create({ tools: tools.map(t => t.definition) })
const result = await tools.find(t => t.name === block.name)!.execute(block.input)

// Custom
const tools = await vistal.tools.format(ctx, (t) => ({ id: t.name, schema: t.parameters }))
```

Tool errors are caught and returned as `{ error }` so the agent can recover instead of aborting.

## Observability

```ts
new Vistal({
  onQuery: ({ toolName, resource, durationMs, error }) => {
    logger.info({ toolName, resource, durationMs })
    if (error) logger.error({ toolName, error: error.message })
  },
})
```

## Other adapters

| Package | Database | Install |
|---|---|---|
| [`@vistal/prisma`](packages/prisma/README.md) | PostgreSQL, MySQL, SQLite (via Prisma) | `npm i @vistal/prisma @prisma/client` |
| [`@vistal/clickhouse`](packages/clickhouse/README.md) | ClickHouse | `npm i @vistal/clickhouse @clickhouse/client` |

Everything above the adapter layer (policies, tool generation, the query IR) is DB-agnostic. An adapter is two methods:

```ts
import type { VistalAdapter, SchemaMap, ResolvedQuery } from "@vistal/core"

class MyAdapter implements VistalAdapter {
  async introspect(): Promise<SchemaMap> { ... }
  async execute(query: ResolvedQuery): Promise<unknown> { ... }
}
```

`SchemaMap`, `ResolvedQuery`, and `FilterNode` are exported from `/core`.

### ClickHouse

```ts
import { createClient } from "@clickhouse/client"
import { createVistal } from "@vistal/clickhouse"

const ch = createClient({ url: process.env.CLICKHOUSE_URL })
const vistal = createVistal(ch, { database: "analytics", defaultPolicy: "deny-all" })

vistal.policy("events", (ctx) => ({
  read:      { tenant_id: ctx.tenant!.id },
  aggregate: { tenant_id: ctx.tenant!.id },
  write: false,
  delete: false,
}))

const tools = await vistal.tools.vercel(ctx)
await generateText({ model, tools, prompt })
```

Schema annotations (`@vistal:description`, `@vistal:sensitive`) live in column and table
COMMENTs rather than Prisma `///` doc-comments. See the
[`@vistal/clickhouse` README](packages/clickhouse/README.md) for details on the `id` column
requirement, the no-relations caveat, and mutation behaviour.

## Examples

[`examples/ecommerce/`](examples/ecommerce/) — three users (admin, support, cross-tenant) against a live Postgres database, with a stress-test suite for tenant isolation, sensitive field exclusion, write policy enforcement, and role-based field denial.

[`examples/clickhouse-analytics/`](examples/clickhouse-analytics/) — the same stress tests recast for ClickHouse: tenant isolation, sensitive-field guard, forced-tenant insert, revenue aggregation, and consolidated-mode schema discovery.

## License

MIT
