import { NeutralTool } from "../tools/generator"

/**
 * A tool formatter converts a provider-neutral {@link NeutralTool} into the
 * shape a specific LLM provider expects. Built-ins are exported below; pass your
 * own function to `ormai.tools.format(ctx, fn)` to support any other provider.
 */
export type ToolFormatter<T = unknown> = (tool: NeutralTool) => T

/** Anthropic Messages API tool shape (also the default `getTools()` shape). */
export interface AnthropicTool {
  name: string
  description: string
  input_schema: object
}

/** OpenAI / OpenAI-compatible function-calling tool shape. */
export interface OpenAITool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: object
  }
}

/**
 * Google Gemini function declaration. Wrap a list of these in
 * `{ functionDeclarations: [...] }` when passing to the Gemini API.
 */
export interface GeminiTool {
  name: string
  description: string
  parameters: object
}

export const anthropic: ToolFormatter<AnthropicTool> = (t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
})

export const openai: ToolFormatter<OpenAITool> = (t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
})

export const gemini: ToolFormatter<GeminiTool> = (t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
})
