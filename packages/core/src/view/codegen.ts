/**
 * Generate TypeScript source from a view's resultSchema, so the static types
 * and the runtime schema can't disagree:
 *
 * ```ts
 * const view = await vistal.view("query_order", args, ctx)
 * fs.writeFileSync("order-view.ts", generateViewTypes(view.resultSchema, "Order"))
 * // → export interface OrderRow { id: string; status: "pending" | ...; ... }
 * //   export interface OrderResult { data: OrderRow[]; hasMore: boolean; nextCursor?: string }
 * ```
 *
 * Handles exactly the vocabulary buildResultSchema emits: objects, arrays,
 * anyOf-null unions, enums, and the JSON primitives.
 */
export function generateViewTypes(resultSchema: object, typeName: string): string {
  const envelope = resultSchema as {
    properties?: { data?: { items?: object }; nextCursor?: object }
  }
  const rowSchema = envelope.properties?.data?.items
  if (!rowSchema) {
    throw new Error("generateViewTypes() expects a schema produced by view.resultSchema")
  }

  const rowName = `${typeName}Row`
  const lines: string[] = []
  lines.push(`export interface ${rowName} ${schemaToType(rowSchema, 0)}`)
  lines.push("")
  lines.push(`export interface ${typeName}Result {`)
  lines.push(`  data: ${rowName}[]`)
  lines.push(`  hasMore: boolean`)
  if (envelope.properties?.nextCursor) lines.push(`  nextCursor?: string`)
  lines.push(`}`)
  lines.push("")
  return lines.join("\n")
}

function schemaToType(schema: object, depth: number): string {
  const s = schema as Record<string, unknown>

  if (Array.isArray(s.anyOf)) {
    return (s.anyOf as object[]).map((variant) => schemaToType(variant, depth)).join(" | ")
  }

  switch (s.type) {
    case "null":
      return "null"
    case "boolean":
      return "boolean"
    case "number":
    case "integer":
      return "number"
    case "string":
      if (Array.isArray(s.enum)) {
        return (s.enum as string[]).map((v) => JSON.stringify(v)).join(" | ")
      }
      return "string"
    case "array":
      return `${wrapUnion(schemaToType((s.items as object) ?? {}, depth))}[]`
    case "object": {
      const properties = s.properties as Record<string, object> | undefined
      if (!properties) return "Record<string, unknown>"
      const required = new Set((s.required as string[]) ?? [])
      const indent = "  ".repeat(depth + 1)
      const fields = Object.entries(properties).map(([key, value]) => {
        const opt = required.has(key) ? "" : "?"
        return `${indent}${safePropertyKey(key)}${opt}: ${schemaToType(value, depth + 1)}`
      })
      return `{\n${fields.join("\n")}\n${"  ".repeat(depth)}}`
    }
    default:
      return "unknown"
  }
}

// Union types need parens before [] — (A | null)[] not A | null[].
function wrapUnion(type: string): string {
  return type.includes(" | ") ? `(${type})` : type
}

function safePropertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
}
