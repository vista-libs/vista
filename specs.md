# ORMAI — Build Spec v0.1
## ORM + Access Control Layer for AI Agents (Prisma MVP)

---

## What we're building

A TypeScript library that sits between an LLM agent and a database. It:
1. Introspects a Prisma schema automatically
2. Lets the developer define per-resource access control policies
3. Generates typed LLM tools from the schema + policies
4. Accepts tool calls from the LLM, enforces policy, builds a safe IR, executes via Prisma

The LLM never writes SQL. It never sees the raw schema. It only sees the tools ORMAI generates for it, shaped by the current user's policy.

---

## Project structure

```
ormai/
├── src/
│   ├── index.ts                  # public API exports
│   ├── ormai.ts                  # ORMAI core class
│   ├── types.ts                  # all shared types and interfaces
│   ├── ir/
│   │   ├── types.ts              # IR node type definitions
│   │   └── builder.ts            # builds ResolvedQuery from tool call + policy
│   ├── policy/
│   │   └── engine.ts             # evaluates policy, merges filters, strips fields
│   ├── introspection/
│   │   └── prisma.ts             # parses schema.prisma into SchemaMap
│   ├── tools/
│   │   └── generator.ts          # generates LLM tool definitions from SchemaMap + policy
│   └── adapters/
│       └── prisma.ts             # translates ResolvedQuery → Prisma client calls
├── tests/
│   ├── policy.test.ts
│   ├── ir.test.ts
│   ├── tools.test.ts
│   └── prisma-adapter.test.ts
├── package.json
└── tsconfig.json
```

---

## Types (`src/types.ts`)

```ts
// The raw schema discovered from Prisma
export interface SchemaMap {
  resources: Record<string, ResourceSchema>
}

export interface ResourceSchema {
  name: string           // "orders"
  tableName: string      // "Order" (Prisma model name)
  fields: Record<string, FieldSchema>
  relations: Record<string, RelationSchema>
  description?: string   // from /// @ormai:description annotations
}

export interface FieldSchema {
  name: string
  type: FieldType
  isNullable: boolean
  isId: boolean
  enumValues?: string[]   // if type is "enum"
  description?: string    // from /// @ormai:description annotations
  sensitive?: boolean     // from /// @ormai:sensitive annotations
}

export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "enum"
  | "uuid"
  | "json"

export interface RelationSchema {
  name: string
  targetResource: string
  type: "belongsTo" | "hasMany" | "manyToMany"
  foreignKey: string
  junctionTable?: string   // for manyToMany
}

// Policy definition — what the developer writes
export type PolicyFn<TContext = DefaultContext> = 
  (ctx: TContext) => PolicyResult

export interface PolicyResult {
  read?: boolean | Record<string, unknown>    // true = allow all, false = deny, object = row filter
  write?: boolean | Record<string, unknown>
  delete?: boolean | Record<string, unknown>
  fields?: FieldPolicy
  relations?: Record<string, boolean>
}

export interface FieldPolicy {
  allow?: string[]    // whitelist
  deny?: string[]     // blacklist
  // if neither specified: all fields allowed
}

export interface DefaultContext {
  user: {
    id: string
    role: string
    [key: string]: unknown
  }
  tenant?: {
    id: string
    [key: string]: unknown
  }
  [key: string]: unknown
}
```

---

## IR Types (`src/ir/types.ts`)

The IR is the internal representation of a query after policy has been applied. Adapters receive this and translate to ORM calls. Policy is never re-evaluated after this point.

```ts
export interface ResolvedQuery {
  resource: string
  operation: "find" | "findOne" | "create" | "update" | "delete" | "aggregate"
  
  // Filters — already merged with policy row filters
  filters?: FilterNode
  
  // Fields to return — already stripped by policy
  fields: string[]
  
  // Relations to include — already filtered by policy
  include?: Record<string, ResolvedInclude>
  
  // For find operations
  sort?: SortClause
  pagination?: PaginationClause
  
  // For aggregate operations
  aggregations?: AggregationClause[]
  groupBy?: string[]
  having?: FilterNode
  
  // For create/update
  data?: Record<string, unknown>
}

export interface ResolvedInclude {
  resource: string
  type: "belongsTo" | "hasMany" | "manyToMany"
  foreignKey: string
  fields: string[]
  filters?: FilterNode   // relation's own policy filters injected here
}

// Filter nodes — composable
export type FilterNode =
  | EqFilter
  | InFilter
  | RangeFilter
  | LikeFilter
  | NullFilter
  | AndFilter
  | OrFilter
  | NotFilter

export interface EqFilter   { type: "eq";    field: string; value: unknown }
export interface InFilter   { type: "in";    field: string; values: unknown[] }
export interface RangeFilter{ type: "range"; field: string; gte?: unknown; lte?: unknown; gt?: unknown; lt?: unknown }
export interface LikeFilter { type: "like";  field: string; value: string; mode?: "contains" | "startsWith" | "endsWith" }
export interface NullFilter { type: "null";  field: string; isNull: boolean }
export interface AndFilter  { type: "and";   filters: FilterNode[] }
export interface OrFilter   { type: "or";    filters: FilterNode[] }
export interface NotFilter  { type: "not";   filter: FilterNode }

export interface SortClause {
  field: string
  direction: "asc" | "desc"
}

export interface PaginationClause {
  limit?: number
  offset?: number
  cursor?: string   // for cursor-based pagination
}

export interface AggregationClause {
  fn: "count" | "sum" | "avg" | "min" | "max"
  field: string
  alias: string
}
```

---

## Core class API (`src/ormai.ts`)

```ts
import { SchemaMap, PolicyFn, DefaultContext } from "./types"
import { ResolvedQuery } from "./ir/types"

export interface ORMAIConfig<TContext = DefaultContext> {
  adapter: ORMAIAdapter
  schemaPath?: string           // path to schema.prisma, defaults to ./prisma/schema.prisma
  defaultPolicy?: "deny-all" | "allow-all"   // default: "deny-all"
}

export class ORMAI<TContext = DefaultContext> {
  constructor(config: ORMAIConfig<TContext>)

  // Register a policy for a resource
  policy(resource: string, fn: PolicyFn<TContext>): this

  // Generate LLM tools for a given context
  // Returns Anthropic-compatible tool definitions
  getTools(ctx: TContext, options?: GetToolsOptions): LLMTool[]

  // Execute a tool call from the LLM
  // Validates, applies policy, builds IR, executes via adapter
  executeTool(toolName: string, input: unknown, ctx: TContext): Promise<unknown>

  // Internal: load and cache schema
  private loadSchema(): Promise<SchemaMap>
}

export interface GetToolsOptions {
  resources?: string[]    // limit to specific resources, default: all
  maxTools?: number       // cap tool count, default: unlimited
}

export interface LLMTool {
  name: string
  description: string
  input_schema: object    // JSON Schema
}

export interface ORMAIAdapter {
  introspect(): Promise<SchemaMap>
  execute(query: ResolvedQuery): Promise<unknown>
}
```

---

## Prisma introspection (`src/introspection/prisma.ts`)

Parse `schema.prisma` into a `SchemaMap`. Use the `@prisma/internals` package which exposes `getDMMF()` — it returns a structured representation of the schema without needing a running DB.

```ts
import { getDMMF } from "@prisma/internals"

export async function introspectPrisma(schemaPath: string): Promise<SchemaMap>
```

**What to extract from DMMF:**
- `dmmf.datamodel.models` → resources
- Each model's `fields` → FieldSchema (map Prisma types to ORMAI FieldType)
- Fields with `relationName` → RelationSchema
- Field `documentation` strings → parse for `@ormai:` annotations

**Prisma type mapping:**
```
String    → "string"
Int/Float → "number"
Boolean   → "boolean"
DateTime  → "date"
Json      → "json"
Enum      → "enum" (extract enumValues from dmmf.datamodel.enums)
@id field → isId: true
```

**Annotation parsing** — scan `documentation` (JSDoc comments `///`) for:
```
/// @ormai:description "human readable description for LLM"
/// @ormai:sensitive       → sensitive: true (deny by default)
/// @ormai:searchable      → hint to include in filter schema
```

---

## Policy engine (`src/policy/engine.ts`)

```ts
export function evaluatePolicy<TContext>(
  policy: PolicyFn<TContext> | undefined,
  ctx: TContext,
  operation: "read" | "write" | "delete",
  defaultPolicy: "deny-all" | "allow-all"
): EvaluatedPolicy

export interface EvaluatedPolicy {
  allowed: boolean
  rowFilter?: FilterNode       // injected into every query for this resource
  allowedFields: string[]      // fields the LLM can see and query on
  allowedRelations: string[]   // relation names allowed to include
}

export function mergeFilters(
  policyFilter: FilterNode | undefined,
  llmFilter: FilterNode | undefined
): FilterNode | undefined
// Policy filter is always ANDed with LLM filter
// Policy wins — cannot be overridden by LLM input
```

**Policy result semantics:**
- `read: true` → allow all rows
- `read: false` → deny entirely (resource not in tools)
- `read: { tenant_id: "abc" }` → inject `WHERE tenant_id = 'abc'` into every query
- `fields.deny: ["user_id"]` → strip from returned data AND from tool input schema
- `fields.allow: ["id", "status"]` → only these fields visible
- `relations: { customer: false }` → remove from `include` enum in tool schema

---

## Tool generator (`src/tools/generator.ts`)

Generates Anthropic-compatible tool definitions from SchemaMap + evaluated policies.

```ts
export function generateTools<TContext>(
  schema: SchemaMap,
  policies: Record<string, PolicyFn<TContext>>,
  ctx: TContext,
  defaultPolicy: "deny-all" | "allow-all",
  options?: GetToolsOptions
): LLMTool[]
```

**Tool generation rules:**

For each resource:
1. Evaluate policy with current ctx
2. If `read` is denied → skip entirely, generate no tools
3. If `read` is allowed → generate `query_{resource}` and `get_{resource}`
4. If `write` is allowed → generate `create_{resource}` and `update_{resource}`
5. If `delete` is allowed → generate `delete_{resource}`
6. If resource has numeric fields → generate `aggregate_{resource}`

**Tool input schema rules:**
- `filters` object: only include `allowedFields` from policy. Use enum values for enum fields. Use range object for date/number fields.
- `include` array enum: only `allowedRelations` from policy
- `sort.field` enum: only `allowedFields`
- `limit`: always number, max 100
- Never include fields marked `sensitive` or denied by policy
- Use `description` from `@ormai:description` annotation if present

**Generated tool names:**
```
query_{resource}      → find many with filters/sort/pagination/include
get_{resource}        → find one by id
create_{resource}     → insert one row
update_{resource}     → update by id
delete_{resource}     → delete by id
aggregate_{resource}  → count/sum/avg with optional groupBy
```

---

## IR builder (`src/ir/builder.ts`)

Translates a raw tool call input into a `ResolvedQuery`, applying policy.

```ts
export function buildResolvedQuery<TContext>(
  toolName: string,
  input: unknown,
  schema: SchemaMap,
  policy: PolicyFn<TContext> | undefined,
  ctx: TContext,
  defaultPolicy: "deny-all" | "allow-all"
): ResolvedQuery
```

**Steps:**
1. Parse `toolName` → extract `operation` and `resource` (e.g. `query_orders` → `find`, `orders`)
2. Validate `resource` exists in schema
3. Evaluate policy for this ctx + operation
4. If not allowed → throw `PolicyViolationError`
5. Parse `input` filters → build FilterNode tree (validate field names against allowedFields)
6. Merge policy row filter into filters with AND
7. Resolve `include` → for each relation, evaluate that resource's policy independently, build ResolvedInclude
8. Strip any fields not in `allowedFields`
9. Return complete ResolvedQuery

**Validation errors** (throw, never silently ignore):
- Unknown field in filters → `ValidationError`
- Unknown relation in include → `ValidationError`
- Operation not permitted → `PolicyViolationError`
- Invalid filter value type → `ValidationError`

---

## Prisma adapter (`src/adapters/prisma.ts`)

Translates `ResolvedQuery` into Prisma client calls. Receives only already-validated, policy-applied IR.

```ts
import { PrismaClient } from "@prisma/client"
import { ORMAIAdapter } from "../ormai"

export class PrismaAdapter implements ORMAIAdapter {
  constructor(private prisma: PrismaClient, private schemaPath?: string)
  
  async introspect(): Promise<SchemaMap>   // delegates to introspection/prisma.ts
  async execute(query: ResolvedQuery): Promise<unknown>
}
```

**IR → Prisma translation:**

```
ResolvedQuery.operation  → prisma[resource].findMany / findUnique / create / update / delete
ResolvedQuery.filters    → where clause (see filter mapping below)
ResolvedQuery.fields     → select object (field: true for each)
ResolvedQuery.include    → include object with nested select + where
ResolvedQuery.sort       → orderBy
ResolvedQuery.pagination → take / skip / cursor
ResolvedQuery.data       → data object for create/update
```

**FilterNode → Prisma where mapping:**
```ts
EqFilter    → { [field]: value }
InFilter    → { [field]: { in: values } }
RangeFilter → { [field]: { gte, lte, gt, lt } }  (only defined keys)
LikeFilter  → { [field]: { contains/startsWith/endsWith: value, mode: "insensitive" } }
NullFilter  → { [field]: isNull ? null : { not: null } }
AndFilter   → { AND: filters.map(translate) }
OrFilter    → { OR: filters.map(translate) }
NotFilter   → { NOT: translate(filter) }
```

---

## Public API (`src/index.ts`)

```ts
export { ORMAI } from "./ormai"
export { PrismaAdapter } from "./adapters/prisma"
export type {
  PolicyFn,
  PolicyResult,
  DefaultContext,
  SchemaMap,
  ResourceSchema,
  FieldSchema,
} from "./types"
export type { ResolvedQuery, FilterNode } from "./ir/types"
export { PolicyViolationError, ValidationError } from "./errors"
```

---

## Usage example (what the developer writes)

```ts
import { ORMAI, PrismaAdapter } from "ormai"
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

const ormai = new ORMAI({
  adapter: new PrismaAdapter(prisma),
  schemaPath: "./prisma/schema.prisma",
  defaultPolicy: "deny-all",
})

ormai.policy("orders", (ctx) => ({
  read: { tenant_id: ctx.tenant.id },
  fields: {
    deny: ctx.user.role === "support" ? ["user_id", "internal_notes"] : [],
  },
  relations: {
    customer: ctx.user.role === "support",
    items: true,
  },
}))

ormai.policy("users", (ctx) => ({
  read: { tenant_id: ctx.tenant.id },
  fields: {
    deny: ["password_hash", "email"],
  },
}))

// In your API handler / agent session
const ctx = { user: req.user, tenant: req.tenant }
const tools = ormai.getTools(ctx)

const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  tools,
  messages,
})

// When LLM makes a tool call:
const result = await ormai.executeTool(
  toolUse.name,
  toolUse.input,
  ctx
)
```

---

## Test cases to implement

### Policy engine
- `read: false` → resource absent from tools
- `read: { tenant_id: "x" }` → filter injected in IR
- LLM filter merged with policy filter using AND
- `fields.deny` strips fields from IR and tool schema
- Relation denied → not in include enum

### IR builder
- Unknown field in filters → ValidationError
- Policy violation on operation → PolicyViolationError
- Nested include resolves relation policy independently
- Policy row filter always present regardless of LLM input

### Tool generator
- Only allowed operations generate tools
- Enum fields use correct values in schema
- Sensitive fields absent from tool input schema
- Description annotation appears in tool description

### Prisma adapter
- Each FilterNode type maps correctly to Prisma where
- select only contains allowed fields
- include with nested select + where
- create/update use data field

---

## Dependencies

```json
{
  "dependencies": {
    "@prisma/internals": "^5.0.0"
  },
  "peerDependencies": {
    "@prisma/client": "^5.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^1.0.0",
    "@types/node": "^20.0.0"
  }
}
```

---

## What's explicitly out of scope for this spec

- Aggregations (Tier 2 — add after core is solid)
- Mutations beyond basic create/update/delete
- Any adapter other than Prisma
- Natural language / JQL interfaces
- Multi-language ports
- Cursor pagination (implement offset first)
- `@ormai:searchable` hint (parse annotation, ignore for now)

---

## Definition of done

- [ ] `ormai.getTools(ctx)` returns valid Anthropic tool definitions shaped by policy
- [ ] `ormai.executeTool(name, input, ctx)` executes correctly against a real Prisma + Postgres setup
- [ ] Policy row filters are always injected — cannot be bypassed by LLM input
- [ ] Denied fields never appear in tool schemas or query results
- [ ] All test cases pass
- [ ] Usage example works end to end
