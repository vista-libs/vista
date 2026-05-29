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
