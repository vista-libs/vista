import { describe, it, expect } from "vitest"
import { anthropic, openai, gemini } from "@vistal/core"
import type { NeutralTool } from "@vistal/core"

const tool: NeutralTool = {
  name: "query_orders",
  description: "Query orders",
  parameters: { type: "object", properties: { id: { type: "string" } } },
}

describe("formatters", () => {
  it("anthropic uses input_schema", () => {
    expect(anthropic(tool)).toEqual({
      name: "query_orders",
      description: "Query orders",
      input_schema: tool.parameters,
    })
  })

  it("openai nests under function with type", () => {
    expect(openai(tool)).toEqual({
      type: "function",
      function: {
        name: "query_orders",
        description: "Query orders",
        parameters: tool.parameters,
      },
    })
  })

  it("gemini is a flat function declaration", () => {
    expect(gemini(tool)).toEqual({
      name: "query_orders",
      description: "Query orders",
      parameters: tool.parameters,
    })
  })

  it("formatters share the same parameters reference (no schema mutation)", () => {
    expect(openai(tool).function.parameters).toBe(tool.parameters)
    expect(gemini(tool).parameters).toBe(tool.parameters)
  })
})
