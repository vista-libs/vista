import { describe, it, expect } from "vitest"
import { buildResolvedQuery } from "../packages/core/src/ir/builder"
import type { SchemaMap } from "@vistal/core"
import { PolicyViolationError, ValidationError } from "@vistal/core"

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "Order",
      fields: {
        id:        { name: "id",        type: "uuid",   isNullable: false, isId: true },
        tenant_id: { name: "tenant_id", type: "string", isNullable: false, isId: false },
        status:    { name: "status",    type: "enum",   isNullable: false, isId: false, enumValues: ["pending", "shipped", "delivered"] },
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
      { filters: { status: "pending" } },
      schema,
      { orders: () => ({ read: { tenant_id: "tenant-123" } }) },
      {},
      "deny-all"
    )
    expect(query.filters).toBeDefined()
    const filterStr = JSON.stringify(query.filters)
    expect(filterStr).toContain("tenant_id")
    expect(filterStr).toContain("tenant-123")
    expect(filterStr).toContain("status")
    expect(filterStr).toContain("pending")
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
        { status: "pending", tenant_id: "x", amount: 10 },
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

  it("invalid enum filter value → ValidationError", () => {
    expect(() =>
      buildResolvedQuery(
        "query_orders",
        { filters: { status: "invalid_value" } },
        schema,
        { orders: () => ({ read: true }) },
        {},
        "deny-all"
      )
    ).toThrow(ValidationError)
  })

  it("valid enum filter value passes", () => {
    const query = buildResolvedQuery(
      "query_orders",
      { filters: { status: "pending" } },
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all"
    )
    expect(JSON.stringify(query.filters)).toContain("pending")
  })

  it("write: { tenant_id } forces tenant_id into create data and adds where guard for update", () => {
    const ctx = { tenant: { id: "t1" } }

    const createQuery = buildResolvedQuery(
      "create_orders",
      { amount: 100 },
      schema,
      { orders: () => ({ write: { tenant_id: ctx.tenant.id } }) },
      ctx,
      "deny-all"
    )
    expect(createQuery.data?.tenant_id).toBe("t1")

    const updateQuery = buildResolvedQuery(
      "update_orders",
      { id: "o1", amount: 200 },
      schema,
      { orders: () => ({ write: { tenant_id: ctx.tenant.id } }) },
      ctx,
      "deny-all"
    )
    expect(updateQuery.data?.tenant_id).toBe("t1")
    // Where filter must include tenant guard
    const whereStr = JSON.stringify(updateQuery.filters)
    expect(whereStr).toContain("tenant_id")
    expect(whereStr).toContain("t1")
  })

  it("forced write fields override LLM-supplied values", () => {
    const ctx = { tenant: { id: "t1" } }
    const query = buildResolvedQuery(
      "create_orders",
      { amount: 100, tenant_id: "evil-tenant" },
      schema,
      { orders: () => ({ write: { tenant_id: ctx.tenant.id } }) },
      ctx,
      "deny-all"
    )
    // Policy wins over LLM input
    expect(query.data?.tenant_id).toBe("t1")
  })

  it("aggregate operation is allowed under read policy", () => {
    const query = buildResolvedQuery(
      "aggregate_orders",
      { aggregations: [{ fn: "sum", field: "amount", alias: "total" }] },
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all"
    )
    expect(query.operation).toBe("aggregate")
    expect(query.aggregations).toBeDefined()
  })

  it("offset is bounded to 0 minimum", () => {
    const query = buildResolvedQuery(
      "query_orders",
      { offset: -5, limit: 10 },
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all"
    )
    expect(query.pagination?.offset).toBe(0)
  })
})
