import { describe, it, expect } from "vitest"
import { evaluatePolicy, mergeFilters } from "../src/policy/engine"
import { ResourceSchema } from "../src/types"

const mockResource: ResourceSchema = {
  name: "orders",
  tableName: "Order",
  fields: {
    id:             { name: "id",             type: "uuid",   isNullable: false, isId: true },
    tenant_id:      { name: "tenant_id",      type: "string", isNullable: false, isId: false },
    status:         { name: "status",         type: "string", isNullable: false, isId: false },
    user_id:        { name: "user_id",        type: "string", isNullable: false, isId: false },
    internal_notes: { name: "internal_notes", type: "string", isNullable: true,  isId: false },
    amount:         { name: "amount",         type: "number", isNullable: false, isId: false },
    password_hash:  { name: "password_hash",  type: "string", isNullable: false, isId: false, sensitive: true },
  },
  relations: {
    customer: { name: "customer", targetResource: "users",  type: "belongsTo", foreignKey: "user_id" },
    items:    { name: "items",    targetResource: "items",  type: "hasMany",   foreignKey: "order_id" },
  },
}

describe("evaluatePolicy", () => {
  it("read: false → not allowed", () => {
    const result = evaluatePolicy(
      () => ({ read: false }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(false)
    expect(result.allowedFields).toEqual([])
    expect(result.allowedRelations).toEqual([])
  })

  it("read: true → allowed, all non-sensitive fields", () => {
    const result = evaluatePolicy(
      () => ({ read: true }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(true)
    expect(result.allowedFields).not.toContain("password_hash")
    expect(result.allowedFields).toContain("id")
    expect(result.allowedFields).toContain("status")
    expect(result.rowFilter).toBeUndefined()
  })

  it("read: { tenant_id: 'x' } → row filter injected", () => {
    const result = evaluatePolicy(
      () => ({ read: { tenant_id: "abc" } }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(true)
    expect(result.rowFilter).toEqual({ type: "eq", field: "tenant_id", value: "abc" })
  })

  it("no policy + deny-all → not allowed", () => {
    const result = evaluatePolicy(undefined, {}, "read", "deny-all", mockResource)
    expect(result.allowed).toBe(false)
  })

  it("no policy + allow-all → allowed", () => {
    const result = evaluatePolicy(undefined, {}, "read", "allow-all", mockResource)
    expect(result.allowed).toBe(true)
  })

  it("fields.deny strips denied fields", () => {
    const result = evaluatePolicy(
      () => ({ read: true, fields: { deny: ["user_id", "internal_notes"] } }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(true)
    expect(result.allowedFields).not.toContain("user_id")
    expect(result.allowedFields).not.toContain("internal_notes")
    expect(result.allowedFields).not.toContain("password_hash")
    expect(result.allowedFields).toContain("id")
    expect(result.allowedFields).toContain("status")
  })

  it("fields.allow whitelists fields, still excludes sensitive", () => {
    const result = evaluatePolicy(
      () => ({ read: true, fields: { allow: ["id", "status", "password_hash"] } }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(true)
    expect(result.allowedFields).toContain("id")
    expect(result.allowedFields).toContain("status")
    expect(result.allowedFields).not.toContain("password_hash")
  })

  it("relations: { customer: false } → customer not in allowedRelations", () => {
    const result = evaluatePolicy(
      () => ({ read: true, relations: { customer: false, items: true } }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowedRelations).not.toContain("customer")
    expect(result.allowedRelations).toContain("items")
  })

  it("sensitive field never in allowedFields even without deny list", () => {
    const result = evaluatePolicy(
      () => ({ read: true }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowedFields).not.toContain("password_hash")
  })
})

describe("mergeFilters", () => {
  it("both undefined → undefined", () => {
    expect(mergeFilters(undefined, undefined)).toBeUndefined()
  })

  it("only policy filter → returns policy filter", () => {
    const pf = { type: "eq" as const, field: "tenant_id", value: "x" }
    expect(mergeFilters(pf, undefined)).toEqual(pf)
  })

  it("only llm filter → returns llm filter", () => {
    const lf = { type: "eq" as const, field: "status", value: "active" }
    expect(mergeFilters(undefined, lf)).toEqual(lf)
  })

  it("both filters → AND node", () => {
    const pf = { type: "eq" as const, field: "tenant_id", value: "x" }
    const lf = { type: "eq" as const, field: "status", value: "active" }
    const merged = mergeFilters(pf, lf)
    expect(merged).toEqual({ type: "and", filters: [pf, lf] })
  })
})
