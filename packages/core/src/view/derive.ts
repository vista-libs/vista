import type { View, ViewResult, ViewSubscription } from "./types"
import { ValidationError } from "../errors"

/**
 * A declarative reshape of a view's rows: group, aggregate, sort, limit.
 * Deliberately data-only — safe to accept from an agent (e.g. the model emits
 * the spec for the chart it wants) because it is validated against the source
 * view's result schema and can only reshape rows, never execute code.
 */
export interface DeriveSpec {
  groupBy?: string[]
  aggregations: Array<{
    alias: string
    fn: "count" | "sum" | "avg" | "min" | "max"
    /** Source row field. Optional for `count` (counts rows). */
    field?: string
  }>
  sort?: { field: string; direction?: "asc" | "desc" }
  limit?: number
}

export interface DerivedView<R = Record<string, unknown>> {
  readonly spec: DeriveSpec
  /** JSON Schema of the derived envelope. */
  readonly resultSchema: object
  execute(): Promise<ViewResult<R>>
  subscribe(
    onData: (result: ViewResult<R>) => void,
    options?: { intervalMs?: number; emitInitial?: boolean; onError?: (error: Error) => void },
  ): ViewSubscription
}

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
// Specs may come from an agent — never let an alias write to the prototype chain.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])
const AGG_FNS = new Set(["count", "sum", "avg", "min", "max"])

/**
 * Derive a live, reshaped view from a source view — e.g. turn the agent's
 * `query_order` into a revenue-by-status series:
 *
 * ```ts
 * const revenue = deriveView(ordersView, {
 *   groupBy: ["status"],
 *   aggregations: [{ alias: "revenue", fn: "sum", field: "total" }],
 *   sort: { field: "revenue", direction: "desc" },
 * })
 * revenue.subscribe(({ data }) => chart.update(data))
 * ```
 *
 * The computation happens client-side over the source rows; for large tables
 * prefer an `aggregate_*` view so the database does the work.
 */
export function deriveView<T>(source: View<T>, spec: DeriveSpec): DerivedView {
  const rowProperties = sourceRowProperties(source)
  validateSpec(spec, rowProperties)

  const apply = (rows: T[]): Record<string, unknown>[] => {
    const groupBy = spec.groupBy ?? []
    const groups = new Map<string, Record<string, unknown>[]>()
    for (const row of rows as Record<string, unknown>[]) {
      const key = JSON.stringify(groupBy.map((g) => row[g]))
      const bucket = groups.get(key)
      if (bucket) bucket.push(row)
      else groups.set(key, [row])
    }

    let out: Record<string, unknown>[] = []
    for (const bucket of groups.values()) {
      const row: Record<string, unknown> = {}
      for (const g of groupBy) row[g] = bucket[0][g]
      for (const agg of spec.aggregations) {
        row[agg.alias] = aggregate(bucket, agg.fn, agg.field)
      }
      out.push(row)
    }

    if (spec.sort) {
      const { field } = spec.sort
      const mul = spec.sort.direction === "desc" ? -1 : 1
      out.sort((a, b) => {
        const av = a[field] as number | string | null
        const bv = b[field] as number | string | null
        if (av === bv) return 0
        if (av === null || av === undefined) return mul
        if (bv === null || bv === undefined) return -mul
        return av < bv ? -mul : mul
      })
    }
    if (spec.limit !== undefined) out = out.slice(0, spec.limit)
    return out
  }

  const wrap = (result: ViewResult<T>): ViewResult<Record<string, unknown>> => ({
    data: apply(result.data),
    hasMore: false,
  })

  const resultSchema = buildDerivedSchema(spec, rowProperties)

  return {
    spec,
    resultSchema,
    execute: async () => wrap(await source.execute()),
    subscribe(onData, options) {
      // Diff on the derived output: a source change that doesn't move the
      // derived numbers (e.g. an untouched column changed) must not emit.
      let lastSnapshot: string | undefined
      let emittedOnce = false
      const emitInitial = options?.emitInitial !== false
      return source.subscribe(
        (result) => {
          const derived = wrap(result)
          const snapshot = JSON.stringify(derived)
          const first = !emittedOnce
          emittedOnce = true
          if (snapshot === lastSnapshot) return
          lastSnapshot = snapshot
          if (first && !emitInitial) return
          onData(derived)
        },
        { intervalMs: options?.intervalMs, onError: options?.onError },
      )
    },
  }
}

function aggregate(
  rows: Record<string, unknown>[],
  fn: DeriveSpec["aggregations"][number]["fn"],
  field?: string,
): unknown {
  if (fn === "count") {
    return field
      ? rows.filter((r) => r[field] !== null && r[field] !== undefined).length
      : rows.length
  }
  const values = rows.map((r) => r[field!]).filter((v): v is number => typeof v === "number")
  if (values.length === 0) return null
  switch (fn) {
    case "sum":
      return values.reduce((a, b) => a + b, 0)
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length
    case "min":
      return values.reduce((a, b) => Math.min(a, b))
    case "max":
      return values.reduce((a, b) => Math.max(a, b))
  }
}

function sourceRowProperties(source: View<unknown>): Record<string, unknown> {
  const envelope = source.resultSchema as {
    properties?: { data?: { items?: { properties?: Record<string, unknown> } } }
  }
  return envelope.properties?.data?.items?.properties ?? {}
}

function validateSpec(spec: DeriveSpec, rowProperties: Record<string, unknown>): void {
  if (!Array.isArray(spec.aggregations) || spec.aggregations.length === 0) {
    throw new ValidationError("deriveView() requires at least one aggregation")
  }
  const aliases = new Set<string>()
  for (const agg of spec.aggregations) {
    if (!AGG_FNS.has(agg.fn)) {
      throw new ValidationError(`Unknown aggregation fn "${agg.fn}"`)
    }
    if (!SAFE_KEY.test(agg.alias) || FORBIDDEN_KEYS.has(agg.alias)) {
      throw new ValidationError(`Invalid aggregation alias "${agg.alias}"`)
    }
    if (agg.fn !== "count" && !agg.field) {
      throw new ValidationError(`Aggregation "${agg.alias}" (${agg.fn}) requires a field`)
    }
    if (agg.field && !(agg.field in rowProperties)) {
      throw new ValidationError(`Aggregation field "${agg.field}" is not in the source view`)
    }
    aliases.add(agg.alias)
  }
  for (const g of spec.groupBy ?? []) {
    if (!(g in rowProperties)) {
      throw new ValidationError(`groupBy field "${g}" is not in the source view`)
    }
  }
  if (spec.sort) {
    const sortable = new Set([...(spec.groupBy ?? []), ...aliases])
    if (!sortable.has(spec.sort.field)) {
      throw new ValidationError(
        `Sort field "${spec.sort.field}" must be a groupBy field or an aggregation alias`,
      )
    }
  }
  if (spec.limit !== undefined && (!Number.isInteger(spec.limit) || spec.limit < 1)) {
    throw new ValidationError("limit must be a positive integer")
  }
}

function buildDerivedSchema(spec: DeriveSpec, rowProperties: Record<string, unknown>): object {
  const properties: Record<string, unknown> = {}
  for (const g of spec.groupBy ?? []) properties[g] = rowProperties[g]
  for (const agg of spec.aggregations) {
    properties[agg.alias] = { type: agg.fn === "count" ? "integer" : "number" }
  }
  return {
    type: "object",
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        },
      },
      hasMore: { type: "boolean" },
    },
    required: ["data", "hasMore"],
  }
}
