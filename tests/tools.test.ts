import { describe, it, expect } from "vitest"
import { generateTools } from "../packages/core/src/tools/generator"
import type { SchemaMap } from "@vistal/core"

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "Order",
      description: "Customer purchase orders",
      fields: {
        id:     { name: "id",     type: "uuid",   isNullable: false, isId: true,  hasDefaultValue: true },
        status: {
          name: "status",
          type: "enum",
          isNullable: false,
          isId: false,
          enumValues: ["pending", "shipped", "delivered"],
          description: "Current order status",
        },
        amount:     { name: "amount",     type: "number", isNullable: false, isId: false },
        created_at: { name: "created_at", type: "date",   isNullable: false, isId: false, hasDefaultValue: true },
        secret_key: { name: "secret_key", type: "string", isNullable: true,  isId: false, sensitive: true },
        notes:      { name: "notes",      type: "string", isNullable: true,  isId: false },
      },
      relations: {
        items:    { name: "items",    targetResource: "items",    type: "hasMany",   foreignKey: "order_id" },
        customer: { name: "customer", targetResource: "customers",type: "belongsTo", foreignKey: "customer_id" },
      },
    },
  },
}

describe("generateTools", () => {
  it("read: false → no tools generated", () => {
    const tools = generateTools(schema, {
      orders: () => ({ read: false }),
    }, {}, "deny-all")
    expect(tools).toHaveLength(0)
  })

  it("read allowed + no write → only query/get tools", () => {
    const tools = generateTools(schema, {
      orders: () => ({ read: true, write: false }),
    }, {}, "deny-all")
    const names = tools.map(t => t.name)
    expect(names).toContain("query_orders")
    expect(names).toContain("get_orders")
    expect(names).not.toContain("create_orders")
    expect(names).not.toContain("update_orders")
    expect(names).not.toContain("delete_orders")
  })

  it("write allowed → create and update tools present", () => {
    const tools = generateTools(schema, {
      orders: () => ({ read: true, write: true }),
    }, {}, "deny-all")
    const names = tools.map(t => t.name)
    expect(names).toContain("create_orders")
    expect(names).toContain("update_orders")
  })

  it("delete allowed → delete tool present", () => {
    const tools = generateTools(schema, {
      orders: () => ({ read: true, delete: true }),
    }, {}, "deny-all")
    const names = tools.map(t => t.name)
    expect(names).toContain("delete_orders")
  })

  it("enum fields use correct values in schema", () => {
    const tools = generateTools(schema, {
      orders: () => ({ read: true }),
    }, {}, "deny-all")
    const queryTool = tools.find(t => t.name === "query_orders")!
    const schema_ = queryTool.parameters as Record<string, unknown>
    const filters = schema_.properties as Record<string, unknown>
    const statusFilter = (filters.filters as Record<string, unknown>)
    const statusProps = (statusFilter.properties as Record<string, unknown>)
    const statusSchema = statusProps.status as Record<string, unknown>
    const oneOf = statusSchema.oneOf as Array<Record<string, unknown>>
    const enumDef = oneOf.find((s: Record<string, unknown>) => s.enum !== undefined)
    expect(enumDef?.enum).toEqual(["pending", "shipped", "delivered"])
  })

  it("sensitive fields absent from tool input schema", () => {
    const tools = generateTools(schema, {
      orders: () => ({ read: true, write: true }),
    }, {}, "deny-all")
    const queryTool = tools.find(t => t.name === "query_orders")!
    const schema_ = queryTool.parameters as Record<string, unknown>
    const filters = schema_.properties as Record<string, unknown>
    const filterSchema = filters.filters as Record<string, unknown>
    const filterProps = filterSchema.properties as Record<string, unknown>
    expect(filterProps).not.toHaveProperty("secret_key")

    const createTool = tools.find(t => t.name === "create_orders")!
    const createSchema = createTool.parameters as Record<string, unknown>
    const createProps = createSchema.properties as Record<string, unknown>
    expect(createProps).not.toHaveProperty("secret_key")
  })

  it("description annotation appears in tool description", () => {
    const tools = generateTools(schema, {
      orders: () => ({ read: true }),
    }, {}, "deny-all")
    const queryTool = tools.find(t => t.name === "query_orders")!
    expect(queryTool.description).toContain("Customer purchase orders")
  })

  it("denied relation not in include enum", () => {
    const tools = generateTools(schema, {
      orders: () => ({ read: true, relations: { customer: false, items: true } }),
    }, {}, "deny-all")
    const queryTool = tools.find(t => t.name === "query_orders")!
    const schema_ = queryTool.parameters as Record<string, unknown>
    const props = schema_.properties as Record<string, unknown>
    const includeSchema = props.include as Record<string, unknown>
    const items = includeSchema.items as Record<string, unknown>
    expect(items.enum).not.toContain("customer")
    expect(items.enum).toContain("items")
  })

  it("options.resources limits generated tools", () => {
    const tools = generateTools(
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all",
      { resources: [] }
    )
    expect(tools).toHaveLength(0)
  })

  it("allow-all default policy generates tools without explicit policy", () => {
    const tools = generateTools(schema, {}, {}, "allow-all")
    const names = tools.map(t => t.name)
    expect(names).toContain("query_orders")
    expect(names).toContain("get_orders")
  })

  it("fields with hasDefaultValue not required in create tool", () => {
    const tools = generateTools(schema, {
      orders: () => ({ read: true, write: true }),
    }, {}, "deny-all")
    const createTool = tools.find(t => t.name === "create_orders")!
    const required = (createTool.parameters as Record<string, unknown>).required as string[] ?? []
    // created_at has hasDefaultValue: true → should NOT be required
    expect(required).not.toContain("created_at")
    // amount has no default and is not nullable → should be required
    expect(required).toContain("amount")
  })

  it("aggregate tool generated for resources with numeric fields", () => {
    const tools = generateTools(schema, {
      orders: () => ({ read: true }),
    }, {}, "deny-all")
    const names = tools.map(t => t.name)
    expect(names).toContain("aggregate_orders")
  })

  it("aggregate tool input schema has aggregations and groupBy", () => {
    const tools = generateTools(schema, {
      orders: () => ({ read: true }),
    }, {}, "deny-all")
    const aggTool = tools.find(t => t.name === "aggregate_orders")!
    const props = (aggTool.parameters as Record<string, unknown>).properties as Record<string, unknown>
    expect(props).toHaveProperty("aggregations")
    expect(props).toHaveProperty("groupBy")
  })
})
