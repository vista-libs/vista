import { Vistal } from "@vistal/core"
import type { DefaultContext, InferResources, VistalConfig } from "@vistal/core"
import type { PrismaClient } from "@prisma/client"
import { PrismaAdapter } from "./adapter"
import type { PgLiveOptions } from "./live"

type CreateConfig<TContext, TClient extends PrismaClient> = Omit<
  VistalConfig<TContext, InferResources<TClient>>,
  "adapter"
> & {
  schemaPath?: string
  /** Postgres LISTEN/NOTIFY for live views (requires the optional `pg` package
   *  and `installLiveTriggers()`); views poll when omitted. */
  live?: PgLiveOptions
}

export function createVistal<TClient extends PrismaClient, TContext = DefaultContext>(
  prisma: TClient,
  config?: CreateConfig<TContext, TClient>,
): Vistal<TContext, InferResources<TClient>> {
  const { schemaPath, live, ...rest } = config ?? {}
  return new Vistal<TContext, InferResources<TClient>>({
    ...rest,
    adapter: new PrismaAdapter(prisma, { schemaPath, live }),
  })
}
