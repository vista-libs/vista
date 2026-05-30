export { ORMAI } from "./ormai"
export type {
  LLMTool,
  ExecutableTool,
  FormattedTool,
  GetToolsOptions,
  QueryEvent,
  ResourceDescriptor,
  ResourceField,
  ResourceRelation,
  ORMAIAdapter,
  ORMAIConfig,
} from "./ormai"
export { PrismaAdapter } from "./adapters/prisma"
export { serializeResult } from "./serializer"

// Tool formatters — turn a provider-neutral tool into a provider-specific shape.
// Built-ins are also reachable via `ormai.tools.<provider>(ctx)`.
export * as formats from "./formatters"
export type {
  ToolFormatter,
  AnthropicTool,
  OpenAITool,
  GeminiTool,
} from "./formatters"
export type { NeutralTool } from "./tools/generator"
export type {
  PolicyFn,
  PolicyResult,
  DefaultContext,
  SchemaMap,
  ResourceSchema,
  FieldSchema,
  InferResources,
} from "./types"
export type { ResolvedQuery, FilterNode } from "./ir/types"
export { PolicyViolationError, ValidationError } from "./errors"
