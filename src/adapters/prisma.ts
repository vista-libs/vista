import type { PrismaClient } from "@prisma/client"
import { ORMAIAdapter } from "../ormai"
import { SchemaMap } from "../types"
import { ResolvedQuery, FilterNode, ResolvedInclude } from "../ir/types"
import { introspectPrisma } from "../introspection/prisma"

export class PrismaAdapter implements ORMAIAdapter {
  constructor(
    private prisma: PrismaClient,
    private schemaPath?: string
  ) {}

  async introspect(): Promise<SchemaMap> {
    const path = this.schemaPath ?? "./prisma/schema.prisma"
    return introspectPrisma(path)
  }

  async execute(query: ResolvedQuery): Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (this.prisma as any)[query.resource]
    if (!model) {
      throw new Error(`Prisma model not found for resource: ${query.resource}`)
    }

    const where = query.filters ? translateFilter(query.filters) : undefined
    const select = buildSelect(query.fields)
    const include = query.include ? buildInclude(query.include) : undefined

    // Merge select and include — Prisma doesn't allow both at the top level.
    // We use select everywhere: scalar fields + nested relation objects in one select.
    const selectOrInclude = include
      ? { select: { ...select, ...include } }
      : { select }

    switch (query.operation) {
      case "find": {
        const args: Record<string, unknown> = { ...selectOrInclude }
        if (where) args.where = where
        if (query.sort) {
          args.orderBy = { [query.sort.field]: query.sort.direction }
        }
        if (query.pagination) {
          if (query.pagination.limit !== undefined) args.take = query.pagination.limit
          if (query.pagination.offset !== undefined) args.skip = query.pagination.offset
        }
        return model.findMany(args)
      }

      case "findOne": {
        const args: Record<string, unknown> = { ...selectOrInclude }
        if (where) args.where = where
        return model.findFirst(args)
      }

      case "create": {
        return model.create({
          data: query.data ?? {},
          ...selectOrInclude,
        })
      }

      case "update": {
        // Extract id from filters for the where clause
        const updateWhere = extractIdWhere(query.filters)
        return model.update({
          where: updateWhere,
          data: query.data ?? {},
          ...selectOrInclude,
        })
      }

      case "delete": {
        const deleteWhere = extractIdWhere(query.filters)
        return model.delete({ where: deleteWhere })
      }

      default:
        throw new Error(`Unsupported operation: ${query.operation}`)
    }
  }
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
      // Prisma only supports where on toMany relations, not belongsTo
      ...(relWhere && rel.type !== "belongsTo" ? { where: relWhere } : {}),
    }
  }
  return result
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

function extractIdWhere(
  filters: FilterNode | undefined
): Record<string, unknown> {
  if (!filters) return {}

  // Look for an eq filter on "id"
  if (filters.type === "eq" && filters.field === "id") {
    return { id: filters.value }
  }

  if (filters.type === "and") {
    for (const f of filters.filters) {
      const result = extractIdWhere(f)
      if (result.id !== undefined) return result
    }
  }

  // Fallback: translate the whole filter
  return translateFilter(filters)
}
