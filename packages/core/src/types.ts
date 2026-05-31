// The raw schema discovered from Prisma
export interface SchemaMap {
  resources: Record<string, ResourceSchema>
}

export interface ResourceSchema {
  name: string           // "orders"
  tableName: string      // "Order" (Prisma model name)
  fields: Record<string, FieldSchema>
  relations: Record<string, RelationSchema>
  description?: string   // from /// @vistal:description annotations
}

export interface FieldSchema {
  name: string
  type: FieldType
  isNullable: boolean
  isId: boolean
  hasDefaultValue?: boolean  // field has a DB/schema default (e.g. @default(now()), @default(uuid()))
  enumValues?: string[]      // if type is "enum"
  description?: string       // from /// @vistal:description annotations
  sensitive?: boolean        // from /// @vistal:sensitive annotations
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

// ── Type-level camelCase → snake_case ────────────────────────────────────────

type _CamelToSnake<S extends string> =
  S extends `${infer Head}${infer Tail}`
    ? Head extends Uppercase<Head>
      ? Head extends Lowercase<Head>  // digit or non-alpha — pass through
        ? `${Head}${_CamelToSnake<Tail>}`
        : `_${Lowercase<Head>}${_CamelToSnake<Tail>}`
      : `${Head}${_CamelToSnake<Tail>}`
    : S

/**
 * Derives vistal resource names (snake_case) from a Prisma client type.
 *
 * @example
 * const vistal = new Vistal<DefaultContext, InferResources<typeof prisma>>({ ... })
 * // policy() and getTools() are now type-safe with autocomplete for resource names
 */
export type InferResources<TClient> = _CamelToSnake<
  Exclude<keyof TClient, `$${string}` | symbol | number> & string
>
