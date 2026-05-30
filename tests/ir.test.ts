import { describe, it, expect } from "vitest"
import { buildResolvedQuery } from "../src/ir/builder"
import { SchemaMap } from "../src/types"
import { PolicyViolationError, ValidationError } from "../src/errors"

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "Order",
      fields: {
        id:        { name: "id",        type: "uuid",   isNullable: false, isId: true },
        tenant_id: { name: "tenant_id", type: "string", isNullable: false, isId: false },
        status:    { name: "status",    type: "string", isNullable: false, isId: false },
        amount:    { name: "amount",    type: "number", isNullable: false, isId: false },
        secret:    { name: "secret",    type: "string", isNullable: true,  isId: false, sensitive: true },
      },
      relations: {
        items: {
          name: "items",
          targetResource: "items",
          type: "hasMany",
          foreignKey: "order_id",
        },
      },
    },
    items: {
      name: "items",
      tableName: "Item",
      fields: {
        id:       { name: "id",       type: "uuid",   isNullable: false, isId: true },
        order_id: { name: "order_id", type: "string", isNullable: false, isId: false },
        name:     { name: "name",     type: "string", isNullable: false, isId: false },
      },
      relations: {},
    },
  },
}

describe("buildResolvedQuery", () => {
  it("basic find query", () => {
    const query = buildResolvedQuery(
      "query_orders",
      {},
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all"
    )
    expect(query.operation).toBe("find")
    expect(query.resource).toBe("orders")
    expect(query.fields).toContain("id")
    expect(query.fields).toContain("status")
    expect(query.fields).not.toContain("secret")
  })

  it("unknown field in filters → ValidationError", () => {
    expect(() =>
      buildResolvedQuery(
        "query_orders",
        { filters: { nonexistent_field: "x" } },
        schema,
        { orders: () => ({ read: true }) },
        {},
        "deny-all"
      )
    ).toThrow(ValidationError)
  })

  it("operation not permitted → PolicyViolationError", () => {
    expect(() =>
      buildResolvedQuery(
        "query_orders",
        {},
        schema,
        { orders: () => ({ read: false }) },
        {},
        "deny-all"
      )
    ).toThrow(PolicyViolationError)
  })

  it("policy row filter always present regardless of LLM input", () => {
    const query = buildResolvedQuery(
      "query_orders",
      { filters: { status: "active" } },
      schema,
      { orders: () => ({ read: { tenant_id: "tenant-123" } }) },
      {},
      "deny-all"
    )
    // The merged filter must contain the policy filter
    expect(query.filters).toBeDefined()
    const filterStr = JSON.stringify(query.filters)
    expect(filterStr).toContain("tenant_id")
    expect(filterStr).toContain("tenant-123")
    expect(filterStr).toContain("status")
    expect(filterStr).toContain("active")
  })

  it("disallowed relation in include → ValidationError", () => {
    expect(() =>
      buildResolvedQuery(
        "query_orders",
        { include: ["items"] },
        schema,
        { orders: () => ({ read: true, relations: { items: false } }) },
        {},
        "deny-all"
      )
    ).toThrow(ValidationError)
  })

  it("nested include resolves relation policy independently", () => {
    const query = buildResolvedQuery(
      "query_orders",
      { include: ["items"] },
      schema,
      { orders: () => ({ read: true }), items: () => ({ read: true }) },
      {},
      "deny-all"
    )
    expect(query.include).toBeDefined()
    expect(query.include!.items).toBeDefined()
    expect(query.include!.items.resource).toBe("items")
    expect(query.include!.items.fields).toContain("id")
  })

  it("denied fields stripped from IR", () => {
    const query = buildResolvedQuery(
      "query_orders",
      {},
      schema,
      { orders: () => ({ read: true, fields: { deny: ["amount"] } }) },
      {},
      "deny-all"
    )
    expect(query.fields).not.toContain("amount")
  })

  it("findOne by id sets eq filter", () => {
    const query = buildResolvedQuery(
      "get_orders",
      { id: "order-1" },
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all"
    )
    expect(query.operation).toBe("findOne")
    const filterStr = JSON.stringify(query.filters)
    expect(filterStr).toContain("order-1")
  })

  it("write operation denied → PolicyViolationError", () => {
    expect(() =>
      buildResolvedQuery(
        "create_orders",
        { status: "new", tenant_id: "x", amount: 10 },
        schema,
        { orders: () => ({ read: true, write: false }) },
        {},
        "deny-all"
      )
    ).toThrow(PolicyViolationError)
  })

  it("sort on disallowed field → ValidationError", () => {
    expect(() =>
      buildResolvedQuery(
        "query_orders",
        { sort: { field: "amount", direction: "asc" } },
        schema,
        { orders: () => ({ read: true, fields: { allow: ["id", "status"] } }) },
        {},
        "deny-all"
      )
    ).toThrow(ValidationError)
  })
})
