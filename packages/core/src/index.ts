export { Vistal } from "./vistal"
export type {
  LLMTool,
  ExecutableTool,
  FormattedTool,
  GetToolsOptions,
  QueryEvent,
  ResourceDescriptor,
  ResourceField,
  ResourceRelation,
  VistalAdapter,
  VistalConfig,
} from "./vistal"
export { serializeResult } from "./serializer"

// Tool formatters — turn a provider-neutral tool into a provider-specific shape.
// Built-ins are also reachable via `vistal.tools.<provider>(ctx)`.
export * as formats from "./formatters"
export { anthropic, openai, gemini } from "./formatters"
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
  FieldType,
  RelationSchema,
  InferResources,
} from "./types"
export type { ResolvedQuery, FilterNode, ResolvedInclude } from "./ir/types"
export { PolicyViolationError, ValidationError } from "./errors"
