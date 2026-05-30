import { SchemaMap, PolicyFn, DefaultContext } from "./types"
import { ResolvedQuery } from "./ir/types"
import { buildResolvedQuery } from "./ir/builder"
import { generateTools } from "./tools/generator"

export interface ORMAIConfig<TContext = DefaultContext> {
  adapter: ORMAIAdapter
  schemaPath?: string
  defaultPolicy?: "deny-all" | "allow-all"
}

export interface GetToolsOptions {
  resources?: string[]
  maxTools?: number
}

export interface LLMTool {
  name: string
  description: string
  input_schema: object
}

export interface ORMAIAdapter {
  introspect(): Promise<SchemaMap>
  execute(query: ResolvedQuery): Promise<unknown>
}

export class ORMAI<TContext = DefaultContext> {
  private adapter: ORMAIAdapter
  private schemaPath: string
  private defaultPolicy: "deny-all" | "allow-all"
  private policies: Record<string, PolicyFn<TContext>> = {}
  private schemaCache: SchemaMap | null = null

  constructor(config: ORMAIConfig<TContext>) {
    this.adapter = config.adapter
    this.schemaPath = config.schemaPath ?? "./prisma/schema.prisma"
    this.defaultPolicy = config.defaultPolicy ?? "deny-all"
  }

  policy(resource: string, fn: PolicyFn<TContext>): this {
    this.policies[resource] = fn
    return this
  }

  getTools(ctx: TContext, options?: GetToolsOptions): LLMTool[] {
    if (!this.schemaCache) {
      throw new Error("Schema not loaded. Call loadSchema() before getTools().")
    }
    return generateTools(this.schemaCache, this.policies, ctx, this.defaultPolicy, options)
  }

  async executeTool(toolName: string, input: unknown, ctx: TContext): Promise<unknown> {
    const schema = await this.loadSchema()

    const query = buildResolvedQuery(
      toolName,
      input,
      schema,
      this.policies,
      ctx,
      this.defaultPolicy
    )

    return this.adapter.execute(query)
  }

  async loadSchema(): Promise<SchemaMap> {
    if (!this.schemaCache) {
      this.schemaCache = await this.adapter.introspect()
    }
    return this.schemaCache
  }
}

function extractResource(toolName: string): string {
  const prefixes = ["query_", "get_", "create_", "update_", "delete_", "aggregate_"]
  for (const prefix of prefixes) {
    if (toolName.startsWith(prefix)) {
      return toolName.slice(prefix.length)
    }
  }
  return toolName
}
