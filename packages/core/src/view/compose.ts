import type { View, ViewResult, ViewSubscription } from "./types"

export interface ComposeSubscribeOptions {
  /** Poll interval passed to each input view. */
  intervalMs?: number
  /** Called on input execution errors and transform errors. */
  onError?: (error: Error) => void
}

export interface ComposedView<R> {
  execute(): Promise<R>
  subscribe(onData: (result: R) => void, options?: ComposeSubscribeOptions): ViewSubscription
}

type ViewResults<Vs extends readonly View<unknown>[]> = {
  [K in keyof Vs]: Vs[K] extends View<infer T> ? ViewResult<T> : never
}

/**
 * Combine multiple views with a pure transform — the live answer to multi-step
 * agent queries. Whatever the LLM computed across several tool calls gets
 * reified as app code over policy-enforced inputs:
 *
 * ```ts
 * const topSpenders = compose([ordersView, usersView], (orders, users) =>
 *   rankBySpend(orders.data, users.data),
 * )
 * topSpenders.subscribe((ranking) => leaderboard.update(ranking))
 * ```
 *
 * subscribe() subscribes to every input and recomputes when any of them
 * changes, emitting only when the transformed output actually changed. The
 * inputs stay policy-enforced; the transform is application code, so nothing
 * agent-generated ever executes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function compose<Vs extends readonly View<any>[], R>(
  views: readonly [...Vs],
  transform: (...results: ViewResults<Vs>) => R,
): ComposedView<R> {
  const execute = async (): Promise<R> => {
    const results = await Promise.all(views.map((v) => v.execute()))
    return transform(...(results as ViewResults<Vs>))
  }

  return {
    execute,
    subscribe(onData, options) {
      const latest: Array<ViewResult<unknown> | undefined> = views.map(() => undefined)
      let lastSnapshot: string | undefined
      let stopped = false

      const recompute = (): void => {
        // Wait until every input has produced at least one result.
        if (stopped || latest.some((r) => r === undefined)) return
        try {
          const out = transform(...(latest as ViewResults<Vs>))
          const snapshot = JSON.stringify(out)
          if (snapshot === lastSnapshot) return
          lastSnapshot = snapshot
          onData(out)
        } catch (err) {
          options?.onError?.(err as Error)
        }
      }

      const subs = views.map((view, i) =>
        view.subscribe(
          (result) => {
            latest[i] = result
            recompute()
          },
          { intervalMs: options?.intervalMs, onError: options?.onError },
        ),
      )

      return {
        stop() {
          if (stopped) return
          stopped = true
          for (const s of subs) s.stop()
        },
      }
    },
  }
}
