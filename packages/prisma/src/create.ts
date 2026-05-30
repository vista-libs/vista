import { ORMAI } from "ormai"
import type { DefaultContext, InferResources, ORMAIConfig } from "ormai"
import type { PrismaClient } from "@prisma/client"
import { PrismaAdapter } from "./adapter"

type CreateConfig<TContext, TClient extends PrismaClient> =
  Omit<ORMAIConfig<TContext, InferResources<TClient>>, "adapter"> & {
    schemaPath?: string
  }

export function createOrmai<TClient extends PrismaClient, TContext = DefaultContext>(
  prisma: TClient,
  config?: CreateConfig<TContext, TClient>
): ORMAI<TContext, InferResources<TClient>> {
  const { schemaPath, ...rest } = config ?? {}
  return new ORMAI<TContext, InferResources<TClient>>({
    ...rest,
    adapter: new PrismaAdapter(prisma, schemaPath),
  })
}
