import { SchemaMap, PolicyFn, ResourceSchema, FieldSchema } from "../types"
import { evaluatePolicy, EvaluatedPolicy } from "../policy/engine"
import { GetToolsOptions } from "../vistal"

/**
 * Provider-neutral tool definition. This is the single source of truth from
 * which every provider-specific shape (Anthropic, OpenAI, Gemini, …) is derived
 * by a formatter. `parameters` is a JSON Schema object describing the input.
 */
export interface NeutralTool {
  name: string
  description: string
  parameters: object
}

export function generateTools<TContext>(
  schema: SchemaMap,
  policies: Record<string, PolicyFn<TContext>>,
  ctx: TContext,
  defaultPolicy: "deny-all" | "allow-all",
  options?: GetToolsOptions
): NeutralTool[] {
  const tools: NeutralTool[] = []
  const resourceNames = options?.resources ?? Object.keys(schema.resources)

  for (const resourceName of resourceNames) {
    const resource = schema.resources[resourceName]
    if (!resource) continue

    const readPolicy = evaluatePolicy(policies[resourceName], ctx, "read", defaultPolicy, resource)
    if (!readPolicy.allowed) continue

    const writePolicy = evaluatePolicy(policies[resourceName], ctx, "write", defaultPolicy, resource)
    const deletePolicy = evaluatePolicy(policies[resourceName], ctx, "delete", defaultPolicy, resource)

    tools.push(buildQueryTool(resourceName, resource, readPolicy))
    tools.push(buildGetTool(resourceName, resource, readPolicy))

    if (writePolicy.allowed) {
      const forcedFields = writePolicy.forcedWriteFields ?? {}
      const allRequiredCovered = Object.entries(resource.fields).every(([name, field]) => {
        if (field.isId || field.isNullable || field.hasDefaultValue) return true
        return writePolicy.allowedFields.includes(name) || name in forcedFields
      })
      if (allRequiredCovered) {
        tools.push(buildCreateTool(resourceName, resource, writePolicy))
      }
      tools.push(buildUpdateTool(resourceName, resource, writePolicy))
    }

    if (deletePolicy.allowed) {
      tools.push(buildDeleteTool(resourceName, resource))
    }

    // Aggregate tool if there are numeric fields
    const numericFields = readPolicy.allowedFields.filter(f => {
      const field = resource.fields[f]
      return field && field.type === "number"
    })
    if (numericFields.length > 0) {
      tools.push(buildAggregateTool(resourceName, resource, readPolicy, numericFields))
    }

    if (options?.maxTools && tools.length >= options.maxTools) break
  }

  return tools
}

function buildQueryTool(
  resourceName: string,
  resource: ResourceSchema,
  policy: EvaluatedPolicy
): NeutralTool {
  const description = resource.description
    ? `Query multiple ${resourceName} records. ${resource.description}`
    : `Query multiple ${resourceName} records with filters, sorting, and pagination.`

  return {
    name: `query_${resourceName}`,
    description,
    parameters: {
      type: "object",
      properties: {
        filters: buildFiltersSchema(resource, policy.allowedFields),
        include: buildIncludeSchema(policy.allowedRelations),
        sort: buildSortSchema(policy.allowedFields),
        limit: {
          type: "number",
          description: "Maximum number of records to return (max 100)",
          maximum: 100,
        },
        offset: {
          type: "number",
          description: "Number of records to skip",
        },
      },
      additionalProperties: false,
    },
  }
}

function buildGetTool(
  resourceName: string,
  resource: ResourceSchema,
  policy: EvaluatedPolicy
): NeutralTool {
  const idField = Object.values(resource.fields).find(f => f.isId)
  const idSchema = idField ? buildFieldSchema(idField) : { type: "string" }
  const description = resource.description
    ? `Get a single ${resourceName} by ID. ${resource.description}`
    : `Get a single ${resourceName} by ID.`

  return {
    name: `get_${resourceName}`,
    description,
    parameters: {
      type: "object",
      properties: {
        id: { ...idSchema, description: `ID of the ${resourceName} to retrieve` },
        include: buildIncludeSchema(policy.allowedRelations),
      },
      required: ["id"],
      additionalProperties: false,
    },
  }
}

function buildCreateTool(
  resourceName: string,
  resource: ResourceSchema,
  policy: EvaluatedPolicy
): NeutralTool {
  const writableFields = policy.allowedFields.filter(f => {
    const field = resource.fields[f]
    return field && !field.isId
  })

  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const fieldName of writableFields) {
    const field = resource.fields[fieldName]
    if (!field) continue
    properties[fieldName] = buildFieldSchema(field)
    // Only required if not nullable and has no DB default
    if (!field.isNullable && !field.hasDefaultValue) required.push(fieldName)
  }

  return {
    name: `create_${resourceName}`,
    description: `Create a new ${resourceName} record.`,
    parameters: {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
      additionalProperties: false,
    },
  }
}

function buildUpdateTool(
  resourceName: string,
  resource: ResourceSchema,
  policy: EvaluatedPolicy
): NeutralTool {
  const idField = Object.values(resource.fields).find(f => f.isId)
  const idSchema = idField ? buildFieldSchema(idField) : { type: "string" }

  const writableFields = policy.allowedFields.filter(f => {
    const field = resource.fields[f]
    return field && !field.isId
  })

  const properties: Record<string, unknown> = {
    id: { ...idSchema, description: `ID of the ${resourceName} to update` },
  }

  for (const fieldName of writableFields) {
    const field = resource.fields[fieldName]
    if (!field) continue
    properties[fieldName] = buildFieldSchema(field)
  }

  return {
    name: `update_${resourceName}`,
    description: `Update an existing ${resourceName} record by ID.`,
    parameters: {
      type: "object",
      properties,
      required: ["id"],
      additionalProperties: false,
    },
  }
}

function buildDeleteTool(resourceName: string, resource: ResourceSchema): NeutralTool {
  const idField = Object.values(resource.fields).find(f => f.isId)
  const idSchema = idField ? buildFieldSchema(idField) : { type: "string" }

  return {
    name: `delete_${resourceName}`,
    description: `Delete a ${resourceName} record by ID.`,
    parameters: {
      type: "object",
      properties: {
        id: { ...idSchema, description: `ID of the ${resourceName} to delete` },
      },
      required: ["id"],
      additionalProperties: false,
    },
  }
}

function buildAggregateTool(
  resourceName: string,
  resource: ResourceSchema,
  policy: EvaluatedPolicy,
  numericFields: string[]
): NeutralTool {
  return {
    name: `aggregate_${resourceName}`,
    description: `Aggregate ${resourceName} records (count, sum, avg, min, max with optional groupBy).`,
    parameters: {
      type: "object",
      properties: {
        aggregations: {
          type: "array",
          description: "List of aggregation operations to perform",
          items: {
            type: "object",
            properties: {
              fn: { type: "string", enum: ["count", "sum", "avg", "min", "max"] },
              field: { type: "string", enum: numericFields },
              alias: { type: "string" },
            },
            required: ["fn", "field", "alias"],
            additionalProperties: false,
          },
        },
        filters: buildFiltersSchema(resource, policy.allowedFields),
        groupBy: {
          type: "array",
          items: { type: "string", enum: policy.allowedFields },
          description: "Fields to group by",
        },
      },
      required: ["aggregations"],
      additionalProperties: false,
    },
  }
}

function buildFiltersSchema(
  resource: ResourceSchema,
  allowedFields: string[]
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}

  for (const fieldName of allowedFields) {
    const field = resource.fields[fieldName]
    if (!field) continue

    const description = field.description ?? `Filter by ${fieldName}`

    if (field.type === "enum" && field.enumValues) {
      properties[fieldName] = {
        oneOf: [
          { type: "string", enum: field.enumValues, description },
          {
            type: "object",
            properties: {
              in: { type: "array", items: { type: "string", enum: field.enumValues } },
            },
            additionalProperties: false,
            description: `Filter by multiple ${fieldName} values`,
          },
        ],
      }
    } else if (field.type === "number" || field.type === "date") {
      properties[fieldName] = {
        oneOf: [
          buildFieldSchema(field),
          {
            type: "object",
            properties: {
              gte: buildFieldSchema(field),
              lte: buildFieldSchema(field),
              gt:  buildFieldSchema(field),
              lt:  buildFieldSchema(field),
            },
            additionalProperties: false,
            description: `Range filter for ${fieldName}`,
          },
        ],
      }
    } else if (field.type === "string") {
      properties[fieldName] = {
        oneOf: [
          { type: "string", description },
          {
            type: "object",
            properties: {
              contains:    { type: "string" },
              startsWith:  { type: "string" },
              endsWith:    { type: "string" },
              in:          { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
            description: `String filter for ${fieldName}`,
          },
        ],
      }
    } else {
      properties[fieldName] = { ...buildFieldSchema(field), description }
    }
  }

  return {
    type: "object",
    properties,
    additionalProperties: false,
    description: "Filter conditions",
  }
}

function buildIncludeSchema(allowedRelations: string[]): Record<string, unknown> {
  if (allowedRelations.length === 0) {
    return { type: "array", items: { type: "string", enum: [] }, description: "Relations to include" }
  }
  return {
    type: "array",
    items: { type: "string", enum: allowedRelations },
    description: "Relations to include",
  }
}

function buildSortSchema(allowedFields: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      field: { type: "string", enum: allowedFields },
      direction: { type: "string", enum: ["asc", "desc"] },
    },
    required: ["field", "direction"],
    additionalProperties: false,
    description: "Sort order",
  }
}

function buildFieldSchema(field: FieldSchema): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  if (field.description) base.description = field.description

  switch (field.type) {
    case "string":
    case "uuid":
      return { ...base, type: "string" }
    case "number":
      return { ...base, type: "number" }
    case "boolean":
      return { ...base, type: "boolean" }
    case "date":
      return { ...base, type: "string", format: "date-time" }
    case "json":
      return { ...base, type: "object" }
    case "enum":
      return { ...base, type: "string", enum: field.enumValues ?? [] }
    default:
      return { ...base, type: "string" }
  }
}
