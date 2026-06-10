import type { PrismaClient } from "@prisma/client"

// Postgres LISTEN/NOTIFY change notifications for live views.
//
// Architecture: statement-level triggers broadcast the table name on a single
// channel; one dedicated `pg` connection LISTENs and routes notifications to
// watchers by table. The notification carries no row data — on receipt the
// view re-executes through the full policy pipeline, so native streaming can
// never bypass policy. Requires the optional peer dependency `pg`.

export const DEFAULT_LIVE_CHANNEL = "vistal_changes"
const DEFAULT_DEBOUNCE_MS = 250
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface PgClientLike {
  connect(): Promise<void>
  query(sql: string): Promise<unknown>
  end(): Promise<void>
  on(event: "notification", cb: (msg: { channel: string; payload?: string }) => void): void
}

export interface PgLiveOptions {
  /** Connection string for the dedicated LISTEN connection. */
  connectionString: string
  /** NOTIFY channel. Must match the installed triggers. Default "vistal_changes". */
  channel?: string
  /** Coalesce notification bursts within this window (ms). Default 250. */
  debounceMs?: number
  /** Called when the LISTEN connection cannot be established (e.g. `pg` not
   *  installed). Without it the error is logged; affected views go stale, so
   *  surface this in monitoring. */
  onError?: (error: Error) => void
  /** Test seam: inject a pg-compatible client. Defaults to `new (require("pg").Client)`. */
  clientFactory?: () => PgClientLike | Promise<PgClientLike>
}

interface Watcher {
  tables: Set<string>
  onChange: () => void
  timer?: ReturnType<typeof setTimeout>
}

/**
 * One LISTEN connection fanned out to any number of watchers. Started lazily
 * on the first watch, closed when the last watcher unsubscribes.
 */
export class PgNotifyListener {
  private watchers = new Set<Watcher>()
  private client: PgClientLike | undefined
  private starting: Promise<void> | undefined
  private readonly channel: string
  private readonly debounceMs: number

  constructor(private options: PgLiveOptions) {
    this.channel = options.channel ?? DEFAULT_LIVE_CHANNEL
    if (!IDENT.test(this.channel)) {
      throw new Error(`[vistal] invalid LISTEN channel name: "${this.channel}"`)
    }
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  /** Watch a set of tables; onChange fires (debounced) when any of them changes. */
  watch(tables: string[], onChange: () => void): () => void {
    const watcher: Watcher = {
      tables: new Set(tables.map((t) => t.toLowerCase())),
      onChange,
    }
    this.watchers.add(watcher)
    void this.ensureStarted()
    return () => {
      if (watcher.timer !== undefined) clearTimeout(watcher.timer)
      this.watchers.delete(watcher)
      if (this.watchers.size === 0) void this.stop()
    }
  }

  private ensureStarted(): Promise<void> {
    this.starting ??= this.start().catch((err: Error) => {
      this.starting = undefined
      if (this.options.onError) this.options.onError(err)
      else console.error(`[vistal] live updates unavailable: ${err.message}`)
    })
    return this.starting
  }

  private async start(): Promise<void> {
    const factory =
      this.options.clientFactory ?? defaultClientFactory(this.options.connectionString)
    const client = await factory()
    client.on("notification", (msg) => {
      if (msg.channel === this.channel) this.dispatch(msg.payload)
    })
    await client.connect()
    await client.query(`LISTEN "${this.channel}"`)
    this.client = client
  }

  private dispatch(payload?: string): void {
    const table = payload?.toLowerCase()
    for (const watcher of this.watchers) {
      // Payload is the table name; an empty payload notifies everyone.
      if (table && !watcher.tables.has(table)) continue
      if (watcher.timer !== undefined) continue // burst already pending
      watcher.timer = setTimeout(() => {
        watcher.timer = undefined
        watcher.onChange()
      }, this.debounceMs)
    }
  }

  async stop(): Promise<void> {
    this.starting = undefined
    const client = this.client
    this.client = undefined
    if (client) {
      try {
        await client.end()
      } catch {
        // already closed
      }
    }
  }
}

function defaultClientFactory(connectionString: string): () => Promise<PgClientLike> {
  return async () => {
    let pg: unknown
    try {
      const specifier = "pg"
      pg = await import(specifier)
    } catch {
      throw new Error(
        '[vistal] live updates require the "pg" package. Install it with: npm install pg',
      )
    }
    const mod = pg as {
      Client?: new (c: object) => PgClientLike
      default?: { Client: new (c: object) => PgClientLike }
    }
    const Client = mod.Client ?? mod.default?.Client
    if (!Client) throw new Error('[vistal] could not load Client from the "pg" package')
    return new Client({ connectionString })
  }
}

/**
 * SQL to install the notify trigger function + one statement-level trigger per
 * table. Idempotent (CREATE OR REPLACE / DROP IF EXISTS). Table names are the
 * actual Postgres table names (for Prisma, the model name unless @@map is used).
 */
export function liveTriggersSQL(tables: string[], channel = DEFAULT_LIVE_CHANNEL): string[] {
  if (!IDENT.test(channel)) throw new Error(`[vistal] invalid channel name: "${channel}"`)
  const statements = [
    `CREATE OR REPLACE FUNCTION vistal_notify() RETURNS trigger AS $vistal$
BEGIN
  PERFORM pg_notify('${channel}', TG_TABLE_NAME);
  RETURN NULL;
END;
$vistal$ LANGUAGE plpgsql`,
  ]
  for (const table of tables) {
    if (!IDENT.test(table)) throw new Error(`[vistal] invalid table name: "${table}"`)
    statements.push(`DROP TRIGGER IF EXISTS "vistal_notify_${table}" ON "${table}"`)
    statements.push(
      `CREATE TRIGGER "vistal_notify_${table}" AFTER INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION vistal_notify()`,
    )
  }
  return statements
}

/** Install the notify triggers via a Prisma client. Run once per database (e.g. after migrations). */
export async function installLiveTriggers(
  prisma: PrismaClient,
  tables: string[],
  channel?: string,
): Promise<void> {
  for (const sql of liveTriggersSQL(tables, channel)) {
    await (
      prisma as unknown as { $executeRawUnsafe(q: string): Promise<unknown> }
    ).$executeRawUnsafe(sql)
  }
}
