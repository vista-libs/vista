import { SchemaMap, PolicyFn, FieldSchema } from "../types"
import { ResolvedQuery, ResolvedInclude, FilterNode } from "./types"
import { evaluatePolicy, mergeFilters, PolicyOperation } from "../policy/engine"
import { objectToFilterNode } from "./filters"
import { PolicyViolationError, ValidationError } from "../errors"
import { decodeCursor, type CursorKeyset } from "./cursor"
import type { PaginationConfig } from "../vistal"

export type OperationType = "find" | "findOne" | "create" | "update" | "delete" | "aggregate"

export function parseToolName(toolName: string): { operation: OperationType; resource: string } {
  const prefixes: Array<[string, OperationType]> = [
    ["query_", "find"],
    ["get_", "findOne"],
    ["create_", "create"],
    ["update_", "update"],
    ["delete_", "delete"],
    ["aggregate_", "aggregate"],
  ]

  for (const [prefix, operation] of prefixes) {
    if (toolName.startsWith(prefix)) {
      return { operation, resource: toolName.slice(prefix.length) }
    }
  }

  throw new ValidationError(`Unknown tool name format: ${toolName}`)
}

function operationToPolicy(op: OperationType): PolicyOperation {
  switch (op) {
    case "find":
    case "findOne":
      return "read"
    case "aggregate":
      return "aggregate"
    case "create":
      return "create"
    case "update":
      return "update"
    case "delete":
      return "delete"
  }
}

export function buildResolvedQuery<TContext>(
  toolName: string,
  input: unknown,
  schema: SchemaMap,
  policies: Record<string, PolicyFn<TContext>>,
  ctx: TContext,
  defaultPolicy: "deny-all" | "allow-all",
  paginationConfig: PaginationConfig = { maxLimit: 100, defaultLimit: 50 },
): ResolvedQuery {
  const { operation, resource } = parseToolName(toolName)

  const resourceSchema = schema.resources[resource]
  if (!resourceSchema) {
    throw new ValidationError(`Unknown resource: ${resource}`)
  }

  const policyOp = operationToPolicy(operation)
  const evaluated = evaluatePolicy(policies[resource], ctx, policyOp, defaultPolicy, resourceSchema)

  if (!evaluated.allowed) {
    throw new PolicyViolationError(
      `Operation "${operation}" on "${resource}" is not permitted by policy`,
    )
  }

  const inp = (input ?? {}) as Record<string, unknown>

  // Parse filters from LLM input
  let llmFilter: FilterNode | undefined
  if (inp.filters && typeof inp.filters === "object") {
    llmFilter = parseFilters(
      inp.filters as Record<string, unknown>,
      evaluated.allowedFields,
      resource,
      resourceSchema.fields,
    )
  }

  // Merge policy row filter + forced write fields (for update guard) + LLM filter
  let baseFilter = mergeFilters(evaluated.rowFilter, llmFilter)

  // Resolve includes
  let include: Record<string, ResolvedInclude> | undefined
  if (inp.include && Array.isArray(inp.include)) {
    include = {}
    for (const relationName of inp.include as string[]) {
      if (!evaluated.allowedRelations.includes(relationName)) {
        throw new ValidationError(`Relation "${relationName}" is not allowed`)
      }
      const relation = resourceSchema.relations[relationName]
      if (!relation) {
        throw new ValidationError(`Unknown relation "${relationName}" on resource "${resource}"`)
      }

      const relatedSchema = schema.resources[relation.targetResource]
      const relatedEvaluated = evaluatePolicy(
        policies[relation.targetResource],
        ctx,
        "read",
        defaultPolicy,
        relatedSchema,
      )

      const relatedFields = relatedEvaluated.allowed
        ? relatedEvaluated.allowedFields
        : relatedSchema
          ? Object.values(relatedSchema.fields)
              .filter((f) => !f.sensitive)
              .map((f) => f.name)
          : []

      include[relationName] = {
        resource: relation.targetResource,
        type: relation.type,
        foreignKey: relation.foreignKey,
        fields: relatedFields,
        filters: relatedEvaluated.rowFilter,
      }
    }
  }

  const fields = [...evaluated.allowedFields]
  const pkField = Object.values(resourceSchema.fields).find((f) => f.isId)?.name ?? "id"

  const query: ResolvedQuery = {
    resource,
    operation,
    filters: baseFilter,
    fields,
    include,
  }

  // Sort
  if (inp.sort && typeof inp.sort === "object") {
    const sort = inp.sort as Record<string, unknown>
    const sortField = sort.field as string
    if (!evaluated.allowedFields.includes(sortField)) {
      throw new ValidationError(`Sort field "${sortField}" is not allowed`)
    }
    query.sort = {
      field: sortField,
      direction: (sort.direction as "asc" | "desc") ?? "asc",
    }
  }

  // Pagination — applies to every find so the default page size always caps reads.
  if (operation === "find") {
    const explicitSort = query.sort

    // The cursor is self-describing: decode it first so it can drive the sort.
    let keyset: CursorKeyset | undefined
    if (typeof inp.cursor === "string" && inp.cursor.length > 0) {
      keyset = decodeCursor(inp.cursor)
      if (keyset.sortField !== pkField && !evaluated.allowedFields.includes(keyset.sortField)) {
        throw new ValidationError(`Cursor sort field "${keyset.sortField}" is not allowed`)
      }
    }

    if (keyset) {
      if (explicitSort) {
        // A cursor + an explicit sort must agree — the keyset is meaningless otherwise.
        if (
          explicitSort.field !== keyset.sortField ||
          explicitSort.direction !== keyset.direction
        ) {
          throw new ValidationError("Cursor does not match the requested sort")
        }
      } else {
        // Continue paging under the sort the cursor was issued with.
        query.sort = { field: keyset.sortField, direction: keyset.direction }
      }
    } else if (!query.sort) {
      // No cursor, no explicit sort → default to the primary key for stable order.
      query.sort = { field: pkField, direction: "asc" }
    }

    const cursorField = query.sort!.field
    if (keyset && resourceSchema.fields[cursorField]?.isNullable) {
      throw new ValidationError(
        `Cursor pagination is not supported on nullable sort field "${cursorField}"`,
      )
    }

    const rawLimit = typeof inp.limit === "number" ? inp.limit : paginationConfig.defaultLimit
    const limit = Math.min(Math.max(1, Math.floor(rawLimit)), paginationConfig.maxLimit)

    query.pagination = {
      limit,
      // Cursor wins over offset — only honor offset when paging without a cursor.
      offset: keyset
        ? undefined
        : typeof inp.offset === "number"
          ? Math.max(0, inp.offset)
          : undefined,
      cursor: typeof inp.cursor === "string" ? inp.cursor : undefined,
      keyset,
      primaryKey: pkField,
      cursorField,
    }

    // The adapter needs the pk + sort field on each row to build nextCursor,
    // even when policy didn't expose them. Track injected ones so they can be
    // stripped from returned rows.
    const internalFields: string[] = []
    for (const f of [pkField, cursorField]) {
      if (!fields.includes(f)) {
        fields.push(f)
        internalFields.push(f)
      }
    }
    if (internalFields.length > 0) query.internalFields = internalFields
  }

  // Aggregations
  if (operation === "aggregate") {
    if (inp.aggregations && Array.isArray(inp.aggregations)) {
      for (const agg of inp.aggregations as Array<{ fn: string; field: string; alias: string }>) {
        if (
          agg.fn !== "count" &&
          agg.field !== "*" &&
          !evaluated.allowedFields.includes(agg.field)
        ) {
          throw new ValidationError(
            `Aggregation field "${agg.field}" is not allowed on resource "${resource}"`,
          )
        }
      }
      query.aggregations = inp.aggregations as typeof query.aggregations
    }
    if (inp.groupBy && Array.isArray(inp.groupBy)) {
      const disallowed = (inp.groupBy as string[]).filter(
        (f) => !evaluated.allowedFields.includes(f),
      )
      if (disallowed.length > 0) {
        throw new ValidationError(`groupBy fields not allowed: ${disallowed.join(", ")}`)
      }
      query.groupBy = inp.groupBy as string[]
    }
  }

  // Data for create/update
  if (operation === "create" || operation === "update") {
    const data: Record<string, unknown> = {}

    if (operation === "update" && inp.id !== undefined) {
      const idFilter: FilterNode = { type: "eq", field: "id", value: inp.id }
      query.filters = mergeFilters(baseFilter, idFilter)
    }

    for (const [key, value] of Object.entries(inp)) {
      if (["id", "filters", "include", "sort", "limit", "offset"].includes(key)) continue
      if (!evaluated.allowedFields.includes(key)) {
        throw new ValidationError(`Field "${key}" is not allowed for write`)
      }
      data[key] = value
    }

    // Forced write fields override LLM input (policy wins). The UPDATE WHERE
    // guard is already carried by evaluated.rowFilter (merged into baseFilter
    // above and then with the id below), so only the data injection happens here.
    if (evaluated.forcedWriteFields) {
      Object.assign(data, evaluated.forcedWriteFields)
    }

    query.data = data
  }

  // For findOne, use id as eq filter merged with policy filter
  if (operation === "findOne" && inp.id !== undefined) {
    const idFilter: FilterNode = { type: "eq", field: "id", value: inp.id }
    query.filters = mergeFilters(evaluated.rowFilter, idFilter)
  }

  return query
}

function parseFilters(
  filtersObj: Record<string, unknown>,
  allowedFields: string[],
  resource: string,
  fieldSchemas: Record<string, FieldSchema>,
): FilterNode | undefined {
  // LLM-supplied filters share the policy filter language but are confined to
  // the policy's allowed fields and don't get boolean combinators.
  return objectToFilterNode(filtersObj, {
    fieldSchemas,
    allowField: (field) => {
      if (!allowedFields.includes(field)) {
        throw new ValidationError(
          `Field "${field}" is not allowed for filtering on resource "${resource}"`,
        )
      }
    },
  })
}
