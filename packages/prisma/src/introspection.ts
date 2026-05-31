import { getDMMF } from "@prisma/internals"
import type { SchemaMap, ResourceSchema, FieldSchema, FieldType, RelationSchema } from "@vistal/core"

export async function introspectPrisma(schemaPath: string): Promise<SchemaMap> {
  const dmmf = await getDMMF({ datamodelPath: schemaPath })

  const enumMap: Record<string, string[]> = {}
  for (const e of dmmf.datamodel.enums) {
    enumMap[e.name] = e.values.map(v => v.name)
  }

  const resources: Record<string, ResourceSchema> = {}

  for (const model of dmmf.datamodel.models) {
    const resourceName = toResourceName(model.name)
    const fields: Record<string, FieldSchema> = {}
    const relations: Record<string, RelationSchema> = {}

    const modelDescription = parseDescription(model.documentation)

    for (const field of model.fields) {
      if (field.relationName) {
        const relation = buildRelationSchema(field, model.fields)
        if (relation) {
          relations[field.name] = relation
        }
        continue
      }

      const fieldType = mapPrismaType(field.type, enumMap)
      if (!fieldType) continue

      const doc = field.documentation ?? ""
      const fieldSchema: FieldSchema = {
        name: field.name,
        type: fieldType,
        isNullable: !field.isRequired,
        isId: field.isId,
        hasDefaultValue: field.hasDefaultValue || field.isUpdatedAt || false,
        description: parseDescription(doc) ?? undefined,
        sensitive: parseSensitive(doc),
      }

      if (fieldType === "enum") {
        fieldSchema.enumValues = enumMap[field.type] ?? []
      }

      fields[field.name] = fieldSchema
    }

    resources[resourceName] = {
      name: resourceName,
      tableName: model.name,
      fields,
      relations,
      description: modelDescription ?? undefined,
    }
  }

  return { resources }
}

export function toResourceName(modelName: string): string {
  return modelName
    .replace(/([A-Z])/g, (match, letter, offset) =>
      offset === 0 ? letter.toLowerCase() : `_${letter.toLowerCase()}`
    )
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
}

export function toClientKey(resourceName: string): string {
  return resourceName.replace(/_([a-z])/g, (_, l) => l.toUpperCase())
}

function mapPrismaType(prismaType: string, enumMap: Record<string, string[]>): FieldType | null {
  switch (prismaType) {
    case "String":   return "string"
    case "Int":
    case "Float":
    case "Decimal":  return "number"
    case "Boolean":  return "boolean"
    case "DateTime": return "date"
    case "Json":     return "json"
    case "Bytes":    return "string"
    default:
      // Only treat as enum if it's actually in the enum map
      if (enumMap[prismaType]) return "enum"
      return null
  }
}

function buildRelationSchema(
  field: { name: string; type: string; relationName?: string | null; isList: boolean; relationFromFields?: readonly string[]; relationToFields?: readonly string[] },
  allFields: readonly { name: string; type: string; isList: boolean; relationName?: string | null; relationFromFields?: readonly string[]; relationToFields?: readonly string[] }[]
): RelationSchema | null {
  void allFields
  const targetResource = toResourceName(field.type)

  let relationType: "belongsTo" | "hasMany" | "manyToMany"
  let foreignKey = ""

  if (field.relationFromFields && field.relationFromFields.length > 0) {
    relationType = "belongsTo"
    foreignKey = field.relationFromFields[0]
  } else if (field.isList) {
    relationType = "hasMany"
    foreignKey = ""
  } else {
    relationType = "belongsTo"
    foreignKey = ""
  }

  return {
    name: field.name,
    targetResource,
    type: relationType,
    foreignKey,
  }
}

function parseDescription(doc?: string): string | null {
  if (!doc) return null
  const match = doc.match(/@vistal:description\s+"([^"]+)"/)
  return match ? match[1] : null
}

function parseSensitive(doc: string): boolean {
  return /@vistal:sensitive/.test(doc)
}
