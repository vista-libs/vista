import type { ResolvedQuery } from "../ir/types"
import type { SchemaMap, FieldSchema } from "../types"
import { buildFieldSchema } from "../tools/generator"

/**
 * Build a JSON Schema describing the envelope a View's execute() returns,
 * derived from the resolved (policy-filtered) query and the introspected
 * schema. Property types match the serialized form (Date → date-time string,
 * Decimal → number, BigInt → string).
 */
export function buildResultSchema(query: ResolvedQuery, schema: SchemaMap): object {
  const rowSchema =
    query.operation === "aggregate"
      ? buildAggregateRowSchema(query, schema)
      : buildRowSchema(query, schema)

  return {
    type: "object",
    properties: {
      data: { type: "array", items: rowSchema },
      hasMore: { type: "boolean" },
      nextCursor: { type: "string" },
    },
    required: ["data", "hasMore"],
  }
}

function resultFieldSchema(field: FieldSchema): Record<string, unknown> {
  const base = buildFieldSchema(field)
  // anyOf rather than a type array so schemas carrying `format`/`enum` stay valid
  return field.isNullable ? { anyOf: [base, { type: "null" }] } : base
}

function buildRowSchema(query: ResolvedQuery, schema: SchemaMap): Record<string, unknown> {
  const resource = schema.resources[query.resource]
  const internal = new Set(query.internalFields ?? [])
  const properties: Record<string, unknown> = {}

  for (const fieldName of query.fields) {
    if (internal.has(fieldName)) continue
    const field = resource?.fields[fieldName]
    if (field) properties[fieldName] = resultFieldSchema(field)
  }

  for (const [relName, inc] of Object.entries(query.include ?? {})) {
    const related = schema.resources[inc.resource]
    const relProperties: Record<string, unknown> = {}
    for (const fieldName of inc.fields) {
      const field = related?.fields[fieldName]
      if (field) relProperties[fieldName] = resultFieldSchema(field)
    }
    const relRow = {
      type: "object",
      properties: relProperties,
      required: Object.keys(relProperties),
      additionalProperties: false,
    }
    properties[relName] =
      inc.type === "belongsTo"
        ? { anyOf: [relRow, { type: "null" }] }
        : { type: "array", items: relRow }
  }

  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
}

// Describes the flat-alias row shape the IR promises ({ groupByField, alias }),
// returned by both the ClickHouse and Prisma adapters.
function buildAggregateRowSchema(query: ResolvedQuery, schema: SchemaMap): Record<string, unknown> {
  const resource = schema.resources[query.resource]
  const properties: Record<string, unknown> = {}

  for (const fieldName of query.groupBy ?? []) {
    const field = resource?.fields[fieldName]
    if (field) properties[fieldName] = resultFieldSchema(field)
  }

  for (const agg of query.aggregations ?? []) {
    properties[agg.alias] = { type: agg.fn === "count" ? "integer" : "number" }
  }

  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
}
