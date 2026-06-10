# @vistal/prisma

**Row-level security and access control for AI agents — Prisma adapter.**

[![npm](https://img.shields.io/npm/v/@vistal/prisma)](https://www.npmjs.com/package/@vistal/prisma) [![license](https://img.shields.io/npm/l/@vistal/prisma)](../../LICENSE) [![TypeScript](https://img.shields.io/badge/types-TypeScript-blue)](./src/index.ts)

Reads your Prisma schema, generates typed LLM tools, and enforces row-level security and field-level access control server-side on every query — in code, not prompts.

---

## Installation

```bash
npm install @vistal/prisma @vistal/core
npm install --save-dev prisma
```

Requires Prisma 5+ and `@prisma/client` as peer dependencies.

---

## Setup

```ts
import { PrismaClient } from "@prisma/client"
import { createVistal } from "@vistal/prisma"

const prisma = new PrismaClient()

const vistal = createVistal(prisma, { defaultPolicy: "deny-all" })
```

`createVistal` infers resource names from your Prisma client type — policy keys are type-checked, so a typo is a compile error. Prisma model names are converted to `snake_case` resource names (`OrderItem` → `order_item`).

If your schema isn't at `./prisma/schema.prisma`, pass `schemaPath`:

```ts
const vistal = createVistal(prisma, {
  defaultPolicy: "deny-all",
  schemaPath: "./db/schema.prisma",
})
```

---

## Schema annotations

Use `///` doc comments to give the LLM better context and mark fields that should never leave the server:

```prisma
/// @vistal:description "A customer purchase order"
model Order {
  id        String      @id @default(uuid())
  tenant_id String
  status    OrderStatus
  total     Decimal

  /// @vistal:description "Order total in cents"
  total     Decimal

  /// @vistal:sensitive
  internal_notes String?
}
```

| Annotation | Effect |
|---|---|
| `@vistal:description "..."` | Added to the tool description so the LLM understands the resource or field |
| `@vistal:sensitive` | Field is stripped at introspection — never appears in tool schemas, arguments, or results |

`@vistal:sensitive` is enforced before policy runs. The field doesn't exist as far as the LLM is concerned.

---

## Policies

```ts
vistal.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },   // row filter — AND-ed into every read
  write:  { tenant_id: ctx.tenant.id },   // force-injected on INSERT, AND-ed into UPDATE WHERE
  delete: false,                           // delete_order tool never generated
  fields:    { deny: ctx.user.role === "support" ? ["internal_notes"] : [] },
  relations: { items: true, customer: ctx.user.role === "admin" },
}))

// Wildcard fallback for resources without an explicit policy()
vistal.policy("*", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  false,
  delete: false,
}))
```

`read`, `write`, and `delete` accept:

| Value | Meaning |
|---|---|
| `true` | allow |
| `false` | deny — no tool generated for this operation |
| `{ field: value }` | row filter (read/delete) or force-injected field (write) |

---

## Connecting to your LLM provider

```ts
// Vercel AI SDK (requires the `ai` package)
const tools = await vistal.tools.vercel(ctx)
const { text } = await generateText({ model, tools, maxSteps: 8, prompt })

// Anthropic
const tools = await vistal.tools.anthropic(ctx)
await anthropic.messages.create({ tools: tools.map(t => t.definition) })
const result = await tools.find(t => t.name === block.name)!.execute(block.input)

// OpenAI
const tools = await vistal.tools.openai(ctx)

// Gemini
const tools = await vistal.tools.gemini(ctx)
```

---

## How Prisma model names map to resource names

Prisma model names (PascalCase) are converted to snake_case resource names:

| Prisma model | vistal resource |
|---|---|
| `Order` | `order` |
| `OrderItem` | `order_item` |
| `UserProfile` | `user_profile` |

These are the strings you pass to `policy()` and that appear in generated tool names (`query_order_item`, `create_order_item`, …).

---

## Security properties

| Property | How Prisma enforces it |
|---|---|
| Row filters on read | `where` clause passed to `findMany` / `findFirst` |
| Write scoping | `write: { tenant_id }` is injected into `create` data and AND-ed into `updateMany` / `deleteMany` WHERE — cross-tenant records won't match |
| `update` / `delete` use `Many` | Ensures the full policy `where` (id + forced filter) is applied — a mismatched tenant gets `{ count: 0 }`, not an error that leaks existence |
| `belongsTo` relation filters | Enforced post-fetch in memory (Prisma doesn't support `where` on to-one includes) |
| Sensitive fields | Stripped at introspection via `@vistal:sensitive` — never passed to Prisma in `select`, `data`, or returned in results |

---

## Live views with LISTEN/NOTIFY

Live views poll by default. On Postgres you can replace polling with native change notifications (requires the optional peer dependency `pg`):

```ts
import { createVistal, installLiveTriggers } from "@vistal/prisma"

// Once per database — e.g. in a migration step. Table names are the actual
// Postgres table names (the Prisma model name unless @@map is used).
await installLiveTriggers(prisma, ["Order", "User"])

const vistal = createVistal(prisma, {
  live: {
    connectionString: process.env.DATABASE_URL!,
    channel: "vistal_changes",   // default
    debounceMs: 250,             // coalesce notification bursts (default)
    onError: (e) => logger.warn("live updates unavailable", e),
  },
})
```

How it works: statement-level triggers `pg_notify` the **table name only** on one channel; a single dedicated `pg` connection LISTENs and routes notifications to the views watching that table (including tables of eager-loaded relations). On a notification the view re-executes through the full policy pipeline — notifications never carry data, so they can never bypass policy. The LISTEN connection starts lazily with the first subscription and closes with the last. If the connection can't be established (e.g. `pg` missing), `onError` fires and affected views go stale — monitor it, or omit `live` to stay on polling.

`liveTriggersSQL(tables, channel?)` returns the raw SQL if you prefer to manage triggers in your own migrations.

---

## Exports

| Export | Purpose |
|---|---|
| `createVistal(prisma, config?)` | Main entry point — creates a `Vistal` instance with the Prisma adapter wired up and resource types inferred |
| `PrismaAdapter` | The adapter class if you need to instantiate it separately |
| `translateFilter` | Converts a vistal `FilterNode` to a Prisma `where` object — useful when building a custom adapter on top of Prisma |
| `installLiveTriggers` / `liveTriggersSQL` | Install (or emit) the LISTEN/NOTIFY triggers for live views |
| `PgNotifyListener` | The LISTEN connection manager, if you need to wire it manually |

---

## Other adapters

For ClickHouse, use [`@vistal/clickhouse`](https://www.npmjs.com/package/@vistal/clickhouse) instead — same policy API, no relations, schema annotations via column COMMENTs.

---

## License

MIT
