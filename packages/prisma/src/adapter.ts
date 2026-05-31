import type { PrismaClient } from "@prisma/client"
import type { VistalAdapter, SchemaMap, ResolvedQuery, FilterNode, ResolvedInclude } from "@vistal/core"
import { introspectPrisma } from "./introspection"

export class PrismaAdapter implements VistalAdapter {
  constructor(
    private prisma: PrismaClient,
    private schemaPath?: string
  ) {}

  async introspect(): Promise<SchemaMap> {
    const path = this.schemaPath ?? "./prisma/schema.prisma"
    return introspectPrisma(path)
  }

  async execute(query: ResolvedQuery): Promise<unknown> {
    // Convert snake_case resource name to camelCase for Prisma client accessor
    const clientKey = toCamelCase(query.resource)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (this.prisma as any)[clientKey]
    if (!model) {
      throw new Error(`Prisma model not found for resource: ${query.resource} (tried key: ${clientKey})`)
    }

    const where = query.filters ? translateFilter(query.filters) : undefined
    const select = buildSelect(query.fields)
    const include = query.include ? buildInclude(query.include) : undefined

    // Prisma: use select for scalar fields, merge nested relation objects into the same select
    const selectWithIncludes = include
      ? { ...select, ...include }
      : select

    switch (query.operation) {
      case "find": {
        const args: Record<string, unknown> = { select: selectWithIncludes }
        if (where) args.where = where
        if (query.sort) {
          args.orderBy = { [query.sort.field]: query.sort.direction }
        }
        if (query.pagination) {
          if (query.pagination.limit !== undefined) args.take = query.pagination.limit
          if (query.pagination.offset !== undefined) args.skip = query.pagination.offset
        }
        const results = await model.findMany(args)
        return query.include ? applyBelongsToFilters(results, query.include) : results
      }

      case "findOne": {
        const args: Record<string, unknown> = { select: selectWithIncludes }
        if (where) args.where = where
        const result = await model.findFirst(args)
        return result && query.include ? applyBelongsToFiltersOne(result, query.include) : result
      }

      case "create": {
        return model.create({
          data: query.data ?? {},
          select: selectWithIncludes,
        })
      }

      case "update": {
        // Use updateMany with the full where (id + policy row filter) to enforce scoping.
        // A row in a different tenant won't match and won't be updated.
        const fullWhere = where ?? {}
        const result = await model.updateMany({
          where: fullWhere,
          data: query.data ?? {},
        })
        return result  // { count: N }
      }

      case "delete": {
        // Use deleteMany with the full where for the same scoping guarantee.
        const fullWhere = where ?? {}
        return model.deleteMany({ where: fullWhere })  // { count: N }
      }

      case "aggregate": {
        return executeAggregate(model, query, where)
      }

      default:
        throw new Error(`Unsupported operation: ${query.operation}`)
    }
  }
}

function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, l) => l.toUpperCase())
}

function buildSelect(fields: string[]): Record<string, true> {
  const select: Record<string, true> = {}
  for (const field of fields) {
    select[field] = true
  }
  return select
}

function buildInclude(
  include: Record<string, ResolvedInclude>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, rel] of Object.entries(include)) {
    const relSelect = buildSelect(rel.fields)
    const relWhere = rel.filters ? translateFilter(rel.filters) : undefined
    result[name] = {
      select: relSelect,
      // Prisma supports `where` on toMany relations only.
      // For belongsTo we enforce the filter post-fetch via applyBelongsToFilters.
      ...(relWhere && rel.type !== "belongsTo" ? { where: relWhere } : {}),
    }
  }
  return result
}

// For array results: null out any belongsTo includes that don't satisfy the relation's row filter
function applyBelongsToFilters(
  results: unknown[],
  include: Record<string, ResolvedInclude>
): unknown[] {
  return results.map(r => applyBelongsToFiltersOne(r, include))
}

function applyBelongsToFiltersOne(
  result: unknown,
  include: Record<string, ResolvedInclude>
): unknown {
  if (!result || typeof result !== "object") return result
  const out = { ...(result as Record<string, unknown>) }
  for (const [relationName, rel] of Object.entries(include)) {
    if (rel.type !== "belongsTo" || !rel.filters) continue
    const related = out[relationName]
    if (related && typeof related === "object") {
      if (!matchesFilter(related as Record<string, unknown>, rel.filters)) {
        out[relationName] = null
      }
    }
  }
  return out
}

// In-memory filter evaluation for post-fetch enforcement.
// Covers eq/in/and/or which are the only filter types policy generates.
function matchesFilter(obj: Record<string, unknown>, filter: FilterNode): boolean {
  switch (filter.type) {
    case "eq":  return obj[filter.field] === filter.value
    case "in":  return (filter.values as unknown[]).includes(obj[filter.field])
    case "and": return filter.filters.every(f => matchesFilter(obj, f))
    case "or":  return filter.filters.some(f => matchesFilter(obj, f))
    default:    return true  // conservative: pass unknown filter types
  }
}

async function executeAggregate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any,
  query: ResolvedQuery,
  where: Record<string, unknown> | undefined
): Promise<unknown> {
  const aggs = query.aggregations ?? []
  const groupBy = query.groupBy

  if (groupBy && groupBy.length > 0) {
    // Prisma groupBy
    const _agg: Record<string, unknown> = {}
    for (const a of aggs) {
      if (!_agg[`_${a.fn}`]) _agg[`_${a.fn}`] = {}
      ;(_agg[`_${a.fn}`] as Record<string, boolean>)[a.field] = true
    }
    const args: Record<string, unknown> = { by: groupBy, ..._agg }
    if (where) args.where = where
    return model.groupBy(args)
  }

  // Prisma aggregate
  const _agg: Record<string, unknown> = {}
  for (const a of aggs) {
    if (a.fn === "count") {
      _agg._count = _agg._count ? _agg._count : {}
      if (a.field === "*") {
        _agg._count = true
      } else {
        ;(_agg._count as Record<string, boolean>)[a.field] = true
      }
    } else {
      if (!_agg[`_${a.fn}`]) _agg[`_${a.fn}`] = {}
      ;(_agg[`_${a.fn}`] as Record<string, boolean>)[a.field] = true
    }
  }
  if (Object.keys(_agg).length === 0) _agg._count = true

  const args: Record<string, unknown> = { ..._agg }
  if (where) args.where = where
  return model.aggregate(args)
}

export function translateFilter(node: FilterNode): Record<string, unknown> {
  switch (node.type) {
    case "eq":
      return { [node.field]: node.value }

    case "in":
      return { [node.field]: { in: node.values } }

    case "range": {
      const rangeObj: Record<string, unknown> = {}
      if (node.gte !== undefined) rangeObj.gte = node.gte
      if (node.lte !== undefined) rangeObj.lte = node.lte
      if (node.gt !== undefined)  rangeObj.gt  = node.gt
      if (node.lt !== undefined)  rangeObj.lt  = node.lt
      return { [node.field]: rangeObj }
    }

    case "like": {
      const mode = "insensitive"
      return { [node.field]: { [node.mode ?? "contains"]: node.value, mode } }
    }

    case "null":
      return { [node.field]: node.isNull ? null : { not: null } }

    case "and":
      return { AND: node.filters.map(translateFilter) }

    case "or":
      return { OR: node.filters.map(translateFilter) }

    case "not":
      return { NOT: translateFilter(node.filter) }
  }
}
