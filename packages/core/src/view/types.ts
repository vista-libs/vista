/** Row-level deltas between two emissions, computed when `diffKey` is set. */
export interface RowChanges<T = Record<string, unknown>> {
  added: T[]
  removed: T[]
  updated: T[]
}

/** The uniform envelope returned by View.execute(), regardless of operation.
 *  find passes the adapter envelope through; findOne wraps the single row
 *  (or none); aggregate wraps the grouped rows. */
export interface ViewResult<T = Record<string, unknown>> {
  data: T[]
  hasMore: boolean
  nextCursor?: string
  /** Present on subscription emissions when `diffKey` is set. */
  changes?: RowChanges<T>
}

export interface SubscribeOptions {
  /** Poll interval in ms. Ignored when the adapter provides native subscribe. Default 5000. */
  intervalMs?: number
  /** Emit the first result immediately instead of waiting for a change. Default true. */
  emitInitial?: boolean
  /** Called on execution errors; polling continues (with backoff). Errors are swallowed if omitted. */
  onError?: (error: Error) => void
  /** Random jitter applied to each poll delay, as a fraction of the interval
   *  (0–1). Spreads load when many dashboards poll the same database. Default 0. */
  jitter?: number
  /** Row identity field (e.g. "id"). When set, emissions include `changes` —
   *  row-level added/removed/updated deltas for smooth chart updates. */
  diffKey?: string
}

export interface ViewSubscription {
  /** Stop polling / unsubscribe. Idempotent. */
  stop(): void
}

/**
 * The persistable form of a view: plain JSON, safe to store in a database or
 * config. Deliberately excludes the context — ctx is the security boundary and
 * must be re-resolved when the view is rehydrated with `vistal.viewFromJSON`.
 */
export interface SerializedView {
  vistal: "view"
  v: 1
  toolName: string
  args: unknown
}

/** A named view definition for the registry (`vistal.registerView`). */
export interface ViewDefinition {
  toolName: string
  args?: unknown
  description?: string
}

/**
 * A captured agent query: re-executable through the full policy pipeline
 * without the LLM in the loop, with a runtime JSON Schema of its result shape.
 * Created via `vistal.view(toolName, args, ctx)`.
 */
export interface View<T = Record<string, unknown>> {
  readonly toolName: string
  readonly args: unknown
  readonly resource: string
  readonly operation: "find" | "findOne" | "aggregate"
  /** Registry name when opened via `vistal.openView()`. */
  readonly name?: string
  /** JSON Schema of the envelope execute() returns. Snapshot taken at view
   *  creation — if policies later narrow the allowed fields, rows simply omit
   *  the removed properties. */
  readonly resultSchema: object
  /** Re-run the query. Policies are re-evaluated on every call. */
  execute(): Promise<ViewResult<T>>
  /** Watch the query for changes: polls + diffs (or uses the adapter's native
   *  change notifications when available) and calls onData only when the
   *  result actually changed. All subscribers on the same View share one
   *  polling loop. */
  subscribe(onData: (result: ViewResult<T>) => void, options?: SubscribeOptions): ViewSubscription
  /** Persistable form (no ctx). Rehydrate with `vistal.viewFromJSON(json, ctx)`. */
  toJSON(): SerializedView
}
