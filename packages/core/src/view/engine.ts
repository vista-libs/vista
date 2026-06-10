import type { ViewResult, RowChanges, SubscribeOptions, ViewSubscription } from "./types"

export const DEFAULT_VIEW_INTERVAL_MS = 5000
export const DEFAULT_MAX_BACKOFF_MS = 60_000

/** Caps concurrent view executions across a Vistal instance so a fleet of
 *  dashboards cannot stampede the database. */
export class Semaphore {
  private active = 0
  private queue: Array<() => void> = []

  constructor(private max: number) {}

  async run<R>(fn: () => Promise<R>): Promise<R> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

interface Subscriber<T> {
  onData: (result: ViewResult<T>) => void
  onError?: (error: Error) => void
  emitInitial: boolean
  intervalMs: number
  jitter: number
  diffKey?: string
  /** Set after the subscriber has seen (or deliberately skipped) a result. */
  baselined: boolean
  seenSnapshot?: string
  seenData?: T[]
}

/**
 * One execution loop per View, fanned out to any number of subscribers.
 *
 * - Polling: a single recursive setTimeout — overlap-free, with exponential
 *   backoff on consecutive errors and optional jitter. The effective interval
 *   is the minimum across active subscribers.
 * - Native: when the adapter provides change notifications, they replace the
 *   timer; bursts are coalesced by the in-flight guard.
 * - Each subscriber tracks the last snapshot it saw, so late subscribers get
 *   the cached result immediately and only genuinely new data afterwards.
 */
export class ViewEngine<T> {
  private subscribers = new Set<Subscriber<T>>()
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight = false
  private pendingNotify = false
  private consecutiveErrors = 0
  private lastResult: ViewResult<T> | undefined
  private lastSnapshot: string | undefined
  private unsubscribeNative: (() => void) | undefined

  constructor(
    private executeFn: () => Promise<ViewResult<T>>,
    private nativeSubscribe?: (onChange: () => void) => () => void,
    private limiter?: Semaphore,
  ) {}

  subscribe(onData: (result: ViewResult<T>) => void, options?: SubscribeOptions): ViewSubscription {
    const sub: Subscriber<T> = {
      onData,
      onError: options?.onError,
      emitInitial: options?.emitInitial !== false,
      intervalMs: options?.intervalMs ?? DEFAULT_VIEW_INTERVAL_MS,
      jitter: options?.jitter ?? 0,
      diffKey: options?.diffKey,
      baselined: false,
    }
    this.subscribers.add(sub)

    // The engine already has data (another subscriber's poll): serve it from
    // cache instead of waiting for the next tick.
    if (this.lastResult !== undefined && this.lastSnapshot !== undefined) {
      if (sub.emitInitial) this.emitTo(sub, this.lastResult)
      sub.baselined = true
      sub.seenSnapshot = this.lastSnapshot
      sub.seenData = this.lastResult.data
    }

    this.start()

    let stopped = false
    return {
      stop: () => {
        if (stopped) return
        stopped = true
        this.subscribers.delete(sub)
        if (this.subscribers.size === 0) this.stop()
      },
    }
  }

  private start(): void {
    if (this.running) return
    this.running = true

    if (this.nativeSubscribe) {
      void this.tick().then(() => {
        if (this.running && !this.unsubscribeNative) {
          this.unsubscribeNative = this.nativeSubscribe!(() => void this.tick())
        }
      })
      return
    }

    const loop = async (): Promise<void> => {
      await this.tick()
      if (!this.running) return
      this.timer = setTimeout(() => void loop(), this.nextDelay())
    }
    void loop()
  }

  private stop(): void {
    this.running = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.unsubscribeNative?.()
    this.unsubscribeNative = undefined
    this.consecutiveErrors = 0
  }

  private nextDelay(): number {
    let interval = DEFAULT_VIEW_INTERVAL_MS
    let jitter = 0
    for (const sub of this.subscribers) {
      interval = Math.min(interval, sub.intervalMs)
      jitter = Math.max(jitter, sub.jitter)
    }
    // Exponential backoff while the query keeps failing, capped at 60s.
    const backoff = Math.min(interval * 2 ** this.consecutiveErrors, DEFAULT_MAX_BACKOFF_MS)
    const jitterFactor = jitter > 0 ? 1 + (Math.random() * 2 - 1) * jitter : 1
    return Math.max(interval, backoff) * jitterFactor
  }

  private async tick(): Promise<void> {
    // Coalesce notifications that arrive while a query is in flight.
    if (this.inFlight) {
      this.pendingNotify = true
      return
    }
    this.inFlight = true
    try {
      const result = this.limiter ? await this.limiter.run(this.executeFn) : await this.executeFn()
      this.consecutiveErrors = 0
      if (!this.running) return

      const snapshot = JSON.stringify(result)
      this.lastSnapshot = snapshot
      this.lastResult = result

      for (const sub of [...this.subscribers]) {
        if (!sub.baselined) {
          if (sub.emitInitial) this.emitTo(sub, result)
          sub.baselined = true
        } else if (sub.seenSnapshot !== snapshot) {
          this.emitTo(sub, result)
        } else {
          continue
        }
        sub.seenSnapshot = snapshot
        sub.seenData = result.data
      }
    } catch (err) {
      this.consecutiveErrors++
      if (!this.running) return
      for (const sub of [...this.subscribers]) sub.onError?.(err as Error)
    } finally {
      this.inFlight = false
      if (this.pendingNotify) {
        this.pendingNotify = false
        void this.tick()
      }
    }
  }

  private emitTo(sub: Subscriber<T>, result: ViewResult<T>): void {
    if (!sub.diffKey) {
      sub.onData(result)
      return
    }
    sub.onData({ ...result, changes: computeChanges(sub.seenData, result.data, sub.diffKey) })
  }
}

function computeChanges<T>(prev: T[] | undefined, next: T[], key: string): RowChanges<T> {
  const prevByKey = new Map<unknown, T>()
  for (const row of prev ?? []) {
    prevByKey.set((row as Record<string, unknown>)[key], row)
  }

  const added: T[] = []
  const updated: T[] = []
  const seen = new Set<unknown>()
  for (const row of next) {
    const k = (row as Record<string, unknown>)[key]
    seen.add(k)
    if (!prevByKey.has(k)) {
      added.push(row)
    } else if (JSON.stringify(prevByKey.get(k)) !== JSON.stringify(row)) {
      updated.push(row)
    }
  }
  const removed = (prev ?? []).filter((row) => !seen.has((row as Record<string, unknown>)[key]))
  return { added, removed, updated }
}
