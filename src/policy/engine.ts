import { PolicyFn, PolicyResult, ResourceSchema } from "../types"
import { FilterNode, AndFilter } from "../ir/types"

export interface EvaluatedPolicy {
  allowed: boolean
  rowFilter?: FilterNode       // injected into every query for this resource
  allowedFields: string[]      // fields the LLM can see and query on
  allowedRelations: string[]   // relation names allowed to include
}

export function evaluatePolicy<TContext>(
  policy: PolicyFn<TContext> | undefined,
  ctx: TContext,
  operation: "read" | "write" | "delete",
  defaultPolicy: "deny-all" | "allow-all",
  schema?: ResourceSchema
): EvaluatedPolicy {
  let result: PolicyResult = {}

  if (policy) {
    result = policy(ctx)
  }

  const opValue = result[operation]

  // Determine if allowed
  let allowed: boolean
  let rowFilter: FilterNode | undefined

  if (opValue === undefined) {
    allowed = defaultPolicy === "allow-all"
  } else if (opValue === true) {
    allowed = true
  } else if (opValue === false) {
    allowed = false
  } else {
    // It's an object — row filter
    allowed = true
    rowFilter = rowFilterFromObject(opValue as Record<string, unknown>)
  }

  if (!allowed) {
    return { allowed: false, allowedFields: [], allowedRelations: [] }
  }

  // Compute allowed fields
  const allFields = schema ? Object.keys(schema.fields) : []
  const sensitiveFields = schema
    ? Object.values(schema.fields).filter(f => f.sensitive).map(f => f.name)
    : []

  let allowedFields: string[]
  const fieldPolicy = result.fields

  if (fieldPolicy?.allow) {
    // Whitelist — still exclude sensitive
    allowedFields = fieldPolicy.allow.filter(f => !sensitiveFields.includes(f))
  } else if (fieldPolicy?.deny) {
    // Blacklist — also exclude sensitive
    const denySet = new Set([...fieldPolicy.deny, ...sensitiveFields])
    allowedFields = allFields.filter(f => !denySet.has(f))
  } else {
    // No field policy — exclude sensitive
    allowedFields = allFields.filter(f => !sensitiveFields.includes(f))
  }

  // Compute allowed relations
  const allRelations = schema ? Object.keys(schema.relations) : []
  const relationsPolicy = result.relations

  let allowedRelations: string[]
  if (relationsPolicy) {
    allowedRelations = allRelations.filter(r => relationsPolicy[r] !== false)
  } else {
    allowedRelations = allRelations
  }

  return { allowed, rowFilter, allowedFields, allowedRelations }
}

function rowFilterFromObject(obj: Record<string, unknown>): FilterNode {
  const filters: FilterNode[] = Object.entries(obj).map(([field, value]) => ({
    type: "eq" as const,
    field,
    value,
  }))

  if (filters.length === 1) return filters[0]

  return { type: "and", filters } as AndFilter
}

export function mergeFilters(
  policyFilter: FilterNode | undefined,
  llmFilter: FilterNode | undefined
): FilterNode | undefined {
  if (!policyFilter && !llmFilter) return undefined
  if (!policyFilter) return llmFilter
  if (!llmFilter) return policyFilter

  return { type: "and", filters: [policyFilter, llmFilter] } as AndFilter
}
