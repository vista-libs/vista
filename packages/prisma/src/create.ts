import { Vistal } from "@vistal/core"
import type { DefaultContext, InferResources, VistalConfig } from "@vistal/core"
import type { PrismaClient } from "@prisma/client"
import { PrismaAdapter } from "./adapter"

type CreateConfig<TContext, TClient extends PrismaClient> =
  Omit<VistalConfig<TContext, InferResources<TClient>>, "adapter"> & {
    schemaPath?: string
  }

export function createVistal<TClient extends PrismaClient, TContext = DefaultContext>(
  prisma: TClient,
  config?: CreateConfig<TContext, TClient>
): Vistal<TContext, InferResources<TClient>> {
  const { schemaPath, ...rest } = config ?? {}
  return new Vistal<TContext, InferResources<TClient>>({
    ...rest,
    adapter: new PrismaAdapter(prisma, schemaPath),
  })
}
