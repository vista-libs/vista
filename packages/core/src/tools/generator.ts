import { SchemaMap, PolicyFn, ResourceSchema, FieldSchema } from "../types"
import { evaluatePolicy, EvaluatedPolicy } from "../policy/engine"
import type { GetToolsOptions, PaginationConfig } from "../vistal"

/** Fallback pagination bounds for direct callers; production flows pass config from VistalConfig. */
export const DEFAULT_PAGINATION: PaginationConfig = { maxLimit: 100, defaultLimit: 50 }

export const CONSOLIDATED_VERBS = [
  "query",
  "get",
  "create",
  "update",
  "delete",
  "aggregate",
] as const
export const CONSOLIDATED_META = ["list_resources", "describe_resource"] as const
export const RESERVED_TOOL_NAMES = [...CONSOLIDATED_VERBS, ...CONSOLIDATED_META] as string[]

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

// A create tool is only generated if every required field (non-id, non-nullable,
// no default) is either writable by the caller or force-injected by policy —
// otherwise the LLM could never produce a valid insert.
function createIsSatisfiable(resource: ResourceSchema, createPolicy: EvaluatedPolicy): boolean {
  const forcedFields = createPolicy.forcedWriteFields ?? {}
  return Object.entries(resource.fields).every(([name, field]) => {
    if (field.isId || field.isNullable || field.hasDefaultValue) return true
    return createPolicy.allowedFields.includes(name) || name in forcedFields
  })
}

export function generateTools<TContext>(
  schema: SchemaMap,
  policies: Record<string, PolicyFn<TContext>>,
  ctx: TContext,
  defaultPolicy: "deny-all" | "allow-all",
  paginationConfig: PaginationConfig = DEFAULT_PAGINATION,
  options?: GetToolsOptions,
): NeutralTool[] {
  const tools: NeutralTool[] = []
  const resourceNames = options?.resources ?? Object.keys(schema.resources)

  for (const resourceName of resourceNames) {
    const resource = schema.resources[resourceName]
    if (!resource) continue

    const readPolicy = evaluatePolicy(policies[resourceName], ctx, "read", defaultPolicy, resource)
    const createPolicy = evaluatePolicy(
      policies[resourceName],
      ctx,
      "create",
      defaultPolicy,
      resource,
    )
    const updatePolicy = evaluatePolicy(
      policies[resourceName],
      ctx,
      "update",
      defaultPolicy,
      resource,
    )
    const deletePolicy = evaluatePolicy(
      policies[resourceName],
      ctx,
      "delete",
      defaultPolicy,
      resource,
    )
    const aggregatePolicy = evaluatePolicy(
      policies[resourceName],
      ctx,
      "aggregate",
      defaultPolicy,
      resource,
    )

    if (readPolicy.allowed) {
      tools.push(buildQueryTool(resourceName, resource, readPolicy, paginationConfig))
      tools.push(buildGetTool(resourceName, resource, readPolicy))
    }

    if (createPolicy.allowed && createIsSatisfiable(resource, createPolicy)) {
      tools.push(buildCreateTool(resourceName, resource, createPolicy))
    }

    if (updatePolicy.allowed) {
      tools.push(buildUpdateTool(resourceName, resource, updatePolicy))
    }

    if (deletePolicy.allowed) {
      tools.push(buildDeleteTool(resourceName, resource))
    }

    // Aggregate tool if there are numeric fields the caller may read.
    if (aggregatePolicy.allowed) {
      const numericFields = aggregatePolicy.allowedFields.filter(
        (f) => resource.fields[f]?.type === "number",
      )
      if (numericFields.length > 0) {
        tools.push(buildAggregateTool(resourceName, resource, aggregatePolicy, numericFields))
      }
    }

    if (options?.maxTools && tools.length >= options.maxTools) break
  }

  return tools
}

function buildQueryTool(
  resourceName: string,
  resource: ResourceSchema,
  policy: EvaluatedPolicy,
  paginationConfig: PaginationConfig,
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
        ...buildPaginationSchema(paginationConfig),
      },
      additionalProperties: false,
    },
  }
}

// Shared pagination params for query tools (per-resource and consolidated).
function buildPaginationSchema(cfg: PaginationConfig): Record<string, unknown> {
  return {
    limit: {
      type: "number",
      description: `Maximum number of records to return (default ${cfg.defaultLimit}, max ${cfg.maxLimit})`,
      minimum: 1,
      maximum: cfg.maxLimit,
    },
    offset: {
      type: "number",
      description:
        "Number of records to skip (ignored if cursor is supplied; prefer cursor for pagination)",
    },
    cursor: {
      type: "string",
      description:
        "Opaque pagination cursor from a previous result's nextCursor. Pass it alone to fetch the next page — it already carries the sort, so do not resend `sort` (or resend the identical one).",
    },
  }
}

function buildGetTool(
  resourceName: string,
  resource: ResourceSchema,
  policy: EvaluatedPolicy,
): NeutralTool {
  const idField = Object.values(resource.fields).find((f) => f.isId)
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
  policy: EvaluatedPolicy,
): NeutralTool {
  const forcedKeys = new Set(Object.keys(policy.forcedWriteFields ?? {}))
  const writableFields = policy.allowedFields.filter((f) => {
    const field = resource.fields[f]
    return field && !field.isId && !forcedKeys.has(f)
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
  policy: EvaluatedPolicy,
): NeutralTool {
  const idField = Object.values(resource.fields).find((f) => f.isId)
  const idSchema = idField ? buildFieldSchema(idField) : { type: "string" }
  const forcedKeys = new Set(Object.keys(policy.forcedWriteFields ?? {}))

  const writableFields = policy.allowedFields.filter((f) => {
    const field = resource.fields[f]
    return field && !field.isId && !forcedKeys.has(f)
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
  const idField = Object.values(resource.fields).find((f) => f.isId)
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
  numericFields: string[],
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
  allowedFields: string[],
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
              gt: buildFieldSchema(field),
              lt: buildFieldSchema(field),
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
              contains: { type: "string" },
              startsWith: { type: "string" },
              endsWith: { type: "string" },
              in: { type: "array", items: { type: "string" } },
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
    return {
      type: "array",
      items: { type: "string", enum: [] },
      description: "Relations to include",
    }
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

export function generateConsolidatedTools<TContext>(
  schema: SchemaMap,
  policies: Record<string, PolicyFn<TContext>>,
  ctx: TContext,
  defaultPolicy: "deny-all" | "allow-all",
  paginationConfig: PaginationConfig = DEFAULT_PAGINATION,
  options?: GetToolsOptions,
): NeutralTool[] {
  const tools: NeutralTool[] = []
  const candidateNames = options?.resources ?? Object.keys(schema.resources)

  const queryResources: string[] = []
  const createResources: string[] = []
  const updateResources: string[] = []
  const deleteResources: string[] = []
  const aggregateResources: string[] = []

  for (const resourceName of candidateNames) {
    const resource = schema.resources[resourceName]
    if (!resource) continue

    const readPolicy = evaluatePolicy(policies[resourceName], ctx, "read", defaultPolicy, resource)
    if (readPolicy.allowed) queryResources.push(resourceName)

    const aggregatePolicy = evaluatePolicy(
      policies[resourceName],
      ctx,
      "aggregate",
      defaultPolicy,
      resource,
    )
    if (aggregatePolicy.allowed) {
      const numericFields = aggregatePolicy.allowedFields.filter(
        (f) => resource.fields[f]?.type === "number",
      )
      if (numericFields.length > 0) aggregateResources.push(resourceName)
    }

    const createPolicy = evaluatePolicy(
      policies[resourceName],
      ctx,
      "create",
      defaultPolicy,
      resource,
    )
    if (createPolicy.allowed && createIsSatisfiable(resource, createPolicy)) {
      createResources.push(resourceName)
    }

    const updatePolicy = evaluatePolicy(
      policies[resourceName],
      ctx,
      "update",
      defaultPolicy,
      resource,
    )
    if (updatePolicy.allowed) updateResources.push(resourceName)

    const deletePolicy = evaluatePolicy(
      policies[resourceName],
      ctx,
      "delete",
      defaultPolicy,
      resource,
    )
    if (deletePolicy.allowed) deleteResources.push(resourceName)
  }

  const allAccessible = [
    ...new Set([...queryResources, ...createResources, ...updateResources, ...deleteResources]),
  ]
  if (allAccessible.length === 0) return tools

  tools.push({
    name: "list_resources",
    description: "List all accessible resources and which operations are available for each.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  })

  tools.push({
    name: "describe_resource",
    description:
      "Return the field schema and allowed operations for a specific resource. Call this before query/create/update to learn valid field names.",
    parameters: {
      type: "object",
      properties: {
        resource: {
          type: "string",
          enum: allAccessible,
          description: "The resource to describe",
        },
      },
      required: ["resource"],
      additionalProperties: false,
    },
  })

  if (queryResources.length > 0) {
    tools.push({
      name: "query",
      description:
        "Query multiple records of a resource. Call describe_resource first to learn valid filter/sort field names.",
      parameters: {
        type: "object",
        properties: {
          resource: { type: "string", enum: queryResources, description: "The resource to query" },
          filters: {
            type: "object",
            additionalProperties: true,
            description: "Filter conditions (use field names from describe_resource)",
          },
          sort: {
            type: "object",
            properties: {
              field: { type: "string", description: "Field to sort by" },
              direction: { type: "string", enum: ["asc", "desc"] },
            },
            required: ["field", "direction"],
            additionalProperties: false,
          },
          include: {
            type: "array",
            items: { type: "string" },
            description: "Relation names to include",
          },
          ...buildPaginationSchema(paginationConfig),
        },
        required: ["resource"],
        additionalProperties: false,
      },
    })

    tools.push({
      name: "get",
      description: "Get a single record of a resource by ID.",
      parameters: {
        type: "object",
        properties: {
          resource: { type: "string", enum: queryResources, description: "The resource to fetch" },
          id: { description: "ID of the record to retrieve" },
          include: {
            type: "array",
            items: { type: "string" },
            description: "Relation names to include",
          },
        },
        required: ["resource", "id"],
        additionalProperties: false,
      },
    })
  }

  if (createResources.length > 0) {
    tools.push({
      name: "create",
      description:
        "Create a new record. Call describe_resource first to learn required and optional field names.",
      parameters: {
        type: "object",
        properties: {
          resource: {
            type: "string",
            enum: createResources,
            description: "The resource to create",
          },
          data: {
            type: "object",
            additionalProperties: true,
            description: "Field values for the new record",
          },
        },
        required: ["resource", "data"],
        additionalProperties: false,
      },
    })
  }

  if (updateResources.length > 0) {
    tools.push({
      name: "update",
      description:
        "Update an existing record by ID. Call describe_resource first to learn valid field names.",
      parameters: {
        type: "object",
        properties: {
          resource: {
            type: "string",
            enum: updateResources,
            description: "The resource to update",
          },
          id: { description: "ID of the record to update" },
          data: { type: "object", additionalProperties: true, description: "Fields to update" },
        },
        required: ["resource", "id", "data"],
        additionalProperties: false,
      },
    })
  }

  if (deleteResources.length > 0) {
    tools.push({
      name: "delete",
      description: "Delete a record by ID.",
      parameters: {
        type: "object",
        properties: {
          resource: {
            type: "string",
            enum: deleteResources,
            description: "The resource to delete from",
          },
          id: { description: "ID of the record to delete" },
        },
        required: ["resource", "id"],
        additionalProperties: false,
      },
    })
  }

  if (aggregateResources.length > 0) {
    tools.push({
      name: "aggregate",
      description:
        "Aggregate records (count, sum, avg, min, max with optional groupBy). Call describe_resource first to learn valid field names.",
      parameters: {
        type: "object",
        properties: {
          resource: {
            type: "string",
            enum: aggregateResources,
            description: "The resource to aggregate",
          },
          aggregations: {
            type: "array",
            description: "List of aggregation operations to perform",
            items: {
              type: "object",
              properties: {
                fn: { type: "string", enum: ["count", "sum", "avg", "min", "max"] },
                field: {
                  type: "string",
                  description: "Field to aggregate (use numeric fields from describe_resource)",
                },
                alias: { type: "string" },
              },
              required: ["fn", "field", "alias"],
              additionalProperties: false,
            },
          },
          filters: { type: "object", additionalProperties: true, description: "Filter conditions" },
          groupBy: { type: "array", items: { type: "string" }, description: "Fields to group by" },
        },
        required: ["resource", "aggregations"],
        additionalProperties: false,
      },
    })
  }

  return tools
}

export function buildFieldSchema(field: FieldSchema): Record<string, unknown> {
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
