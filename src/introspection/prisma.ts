import { getDMMF } from "@prisma/internals"
import { SchemaMap, ResourceSchema, FieldSchema, FieldType, RelationSchema } from "../types"

export async function introspectPrisma(schemaPath: string): Promise<SchemaMap> {
  const dmmf = await getDMMF({ datamodelPath: schemaPath })

  // Build enum lookup: enumName -> values[]
  const enumMap: Record<string, string[]> = {}
  for (const e of dmmf.datamodel.enums) {
    enumMap[e.name] = e.values.map(v => v.name)
  }

  const resources: Record<string, ResourceSchema> = {}

  for (const model of dmmf.datamodel.models) {
    const resourceName = toResourceName(model.name)
    const fields: Record<string, FieldSchema> = {}
    const relations: Record<string, RelationSchema> = {}

    // Parse model-level documentation
    const modelDescription = parseDescription(model.documentation)

    for (const field of model.fields) {
      if (field.relationName) {
        // Relation field
        const relation = buildRelationSchema(field, model.fields)
        if (relation) {
          relations[field.name] = relation
        }
        continue
      }

      // Scalar field
      const fieldType = mapPrismaType(field.type)
      if (!fieldType) continue  // skip unsupported types

      const doc = field.documentation ?? ""
      const fieldSchema: FieldSchema = {
        name: field.name,
        type: fieldType,
        isNullable: !field.isRequired,
        isId: field.isId,
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

function toResourceName(modelName: string): string {
  // Convert PascalCase model name to snake_case plural resource name
  return modelName
    .replace(/([A-Z])/g, (match, letter, offset) =>
      offset === 0 ? letter.toLowerCase() : `_${letter.toLowerCase()}`
    )
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
}

function mapPrismaType(prismaType: string): FieldType | null {
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
      // Could be an enum — caller checks
      return "enum"
  }
}

function buildRelationSchema(
  field: { name: string; type: string; relationName?: string | null; isList: boolean; relationFromFields?: readonly string[]; relationToFields?: readonly string[] },
  allFields: readonly { name: string; type: string; isList: boolean; relationName?: string | null; relationFromFields?: readonly string[]; relationToFields?: readonly string[] }[]
): RelationSchema | null {
  const targetResource = toResourceName(field.type)

  // Determine relation type
  // belongsTo: scalar FK is on this model (relationFromFields non-empty)
  // hasMany: isList = true, FK is on the other side
  // manyToMany: isList = true, no FK fields (implicit many-to-many)
  let relationType: "belongsTo" | "hasMany" | "manyToMany"
  let foreignKey = ""

  if (field.relationFromFields && field.relationFromFields.length > 0) {
    relationType = "belongsTo"
    foreignKey = field.relationFromFields[0]
  } else if (field.isList) {
    // Check if other model has explicit FK pointing here — approximate as hasMany
    relationType = "hasMany"
    foreignKey = ""  // FK is on the other side
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
  const match = doc.match(/@ormai:description\s+"([^"]+)"/)
  return match ? match[1] : null
}

function parseSensitive(doc: string): boolean {
  return /@ormai:sensitive/.test(doc)
}
