import { SchemaMap, PolicyFn } from "../types"
import { ResolvedQuery, ResolvedInclude, FilterNode } from "./types"
import { evaluatePolicy } from "../policy/engine"
import { mergeFilters } from "../policy/engine"
import { PolicyViolationError, ValidationError } from "../errors"

type OperationType = "find" | "findOne" | "create" | "update" | "delete"

function parseToolName(toolName: string): { operation: OperationType; resource: string } {
  const prefixes: Array<[string, OperationType]> = [
    ["query_", "find"],
    ["get_", "findOne"],
    ["create_", "create"],
    ["update_", "update"],
    ["delete_", "delete"],
  ]

  for (const [prefix, operation] of prefixes) {
    if (toolName.startsWith(prefix)) {
      return { operation, resource: toolName.slice(prefix.length) }
    }
  }

  throw new ValidationError(`Unknown tool name format: ${toolName}`)
}

function operationToPolicy(op: OperationType): "read" | "write" | "delete" {
  if (op === "find" || op === "findOne") return "read"
  if (op === "delete") return "delete"
  return "write"
}

export function buildResolvedQuery<TContext>(
  toolName: string,
  input: unknown,
  schema: SchemaMap,
  policy: PolicyFn<TContext> | undefined,
  ctx: TContext,
  defaultPolicy: "deny-all" | "allow-all"
): ResolvedQuery {
  // 1. Parse toolName
  const { operation, resource } = parseToolName(toolName)

  // 2. Validate resource exists
  const resourceSchema = schema.resources[resource]
  if (!resourceSchema) {
    throw new ValidationError(`Unknown resource: ${resource}`)
  }

  // 3. Evaluate policy
  const policyOp = operationToPolicy(operation)
  const evaluated = evaluatePolicy(policy, ctx, policyOp, defaultPolicy, resourceSchema)

  // 4. Check allowed
  if (!evaluated.allowed) {
    throw new PolicyViolationError(
      `Operation "${operation}" on "${resource}" is not permitted by policy`
    )
  }

  const inp = (input ?? {}) as Record<string, unknown>

  // 5. Parse filters from input
  let llmFilter: FilterNode | undefined
  if (inp.filters && typeof inp.filters === "object") {
    llmFilter = parseFilters(inp.filters as Record<string, unknown>, evaluated.allowedFields, resource)
  }

  // 6. Merge policy row filter with LLM filter
  const filters = mergeFilters(evaluated.rowFilter, llmFilter)

  // 7. Resolve includes
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

      // Evaluate the related resource's read policy independently
      const relatedSchema = schema.resources[relation.targetResource]
      const relatedPolicy = undefined as PolicyFn<TContext> | undefined  // policies are passed via ORMAI — handled in caller
      const relatedEvaluated = evaluatePolicy(relatedPolicy, ctx, "read", defaultPolicy, relatedSchema)

      include[relationName] = {
        resource: relation.targetResource,
        type: relation.type,
        foreignKey: relation.foreignKey,
        fields: relatedEvaluated.allowedFields,
        filters: relatedEvaluated.rowFilter,
      }
    }
  }

  // 8. Resolve fields — strip denied fields
  const fields = evaluated.allowedFields

  // 9. Build query
  const query: ResolvedQuery = {
    resource,
    operation,
    filters,
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

  // Pagination
  if (inp.limit !== undefined || inp.offset !== undefined) {
    query.pagination = {
      limit: typeof inp.limit === "number" ? Math.min(inp.limit, 100) : undefined,
      offset: typeof inp.offset === "number" ? inp.offset : undefined,
    }
  }

  // Data for create/update
  if (operation === "create" || operation === "update") {
    const data: Record<string, unknown> = {}

    // For update, extract id separately
    if (operation === "update" && inp.id !== undefined) {
      query.filters = mergeFilters(filters, { type: "eq", field: "id", value: inp.id })
    }

    for (const [key, value] of Object.entries(inp)) {
      if (key === "id" || key === "filters" || key === "include" || key === "sort" || key === "limit" || key === "offset") {
        continue
      }
      if (!evaluated.allowedFields.includes(key)) {
        throw new ValidationError(`Field "${key}" is not allowed for write`)
      }
      data[key] = value
    }
    query.data = data
  }

  // For findOne, use id as eq filter
  if (operation === "findOne" && inp.id !== undefined) {
    const idFilter: FilterNode = { type: "eq", field: "id", value: inp.id }
    query.filters = mergeFilters(evaluated.rowFilter, idFilter)
  }

  return query
}

function parseFilters(
  filtersObj: Record<string, unknown>,
  allowedFields: string[],
  resource: string
): FilterNode | undefined {
  const nodes: FilterNode[] = []

  for (const [field, value] of Object.entries(filtersObj)) {
    if (!allowedFields.includes(field)) {
      throw new ValidationError(
        `Field "${field}" is not allowed for filtering on resource "${resource}"`
      )
    }

    if (value === null) {
      nodes.push({ type: "null", field, isNull: true })
      continue
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>

      // Range filter
      if ("gte" in obj || "lte" in obj || "gt" in obj || "lt" in obj) {
        nodes.push({ type: "range", field, ...obj })
        continue
      }

      // Like filters
      if ("contains" in obj) {
        nodes.push({ type: "like", field, value: obj.contains as string, mode: "contains" })
        continue
      }
      if ("startsWith" in obj) {
        nodes.push({ type: "like", field, value: obj.startsWith as string, mode: "startsWith" })
        continue
      }
      if ("endsWith" in obj) {
        nodes.push({ type: "like", field, value: obj.endsWith as string, mode: "endsWith" })
        continue
      }

      // In filter
      if ("in" in obj && Array.isArray(obj.in)) {
        nodes.push({ type: "in", field, values: obj.in })
        continue
      }
    }

    if (Array.isArray(value)) {
      nodes.push({ type: "in", field, values: value })
      continue
    }

    // Simple eq
    nodes.push({ type: "eq", field, value })
  }

  if (nodes.length === 0) return undefined
  if (nodes.length === 1) return nodes[0]
  return { type: "and", filters: nodes }
}
