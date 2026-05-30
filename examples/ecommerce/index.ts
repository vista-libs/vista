import "dotenv/config"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, jsonSchema, tool } from "ai"
import { PrismaClient } from "@prisma/client"
import { ORMAI, PrismaAdapter } from "ormai"
import type { DefaultContext, LLMTool } from "ormai"

// ── Setup ─────────────────────────────────────────────────────────────────────

const prisma = new PrismaClient()
const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })

// Note: schemaPath on PrismaAdapter controls introspection (ORMAI config's
// schemaPath field is stored but not used for anything in the current version)
const ormai = new ORMAI<DefaultContext>({
  adapter: new PrismaAdapter(prisma, "./prisma/schema.prisma"),
  defaultPolicy: "deny-all",
})

// ── Policies ──────────────────────────────────────────────────────────────────
// Policy keys must match toResourceName() output: PascalCase → singular snake_case
// Order → "order", User → "user", Product → "product", OrderItem → "order_item"

// Orders: tenant-scoped, role-based field + relation access
ormai.policy("order", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  fields: {
    // internal_notes is @ormai:sensitive — auto-excluded from LLM regardless of policy.
    // We also hide user_id from support staff (they see the order but not who placed it).
    deny: ctx.user.role === "support" ? ["user_id"] : [],
  },
  relations: {
    customer: ctx.user.role === "admin", // support cannot pull customer PII via include
    items: true,
  },
  write: ctx.user.role === "admin",
  delete: false,
}))

// Users: tenant-scoped, no mutations via agent
ormai.policy("user", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  // password_hash is @ormai:sensitive — always excluded regardless of this policy
  fields: { deny: ctx.user.role === "support" ? ["email"] : [] },
  write: false,
  delete: false,
}))

// Products: tenant-scoped, admin can create/update
ormai.policy("product", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  write: ctx.user.role === "admin",
  delete: false,
}))

// OrderItem: no standalone tools — only reachable via order.items include
ormai.policy("order_item", () => ({ read: false }))

// ── Tool conversion ───────────────────────────────────────────────────────────
// Vercel AI SDK accepts JSON Schema directly via jsonSchema(), so no type mapping needed.

function buildTools(ormaiTools: LLMTool[], ctx: DefaultContext) {
  return Object.fromEntries(
    ormaiTools.map((t) => [
      t.name,
      tool({
        description: t.description,
        parameters: jsonSchema(t.input_schema as Parameters<typeof jsonSchema>[0]),
        execute: async (args) => {
          try {
            const result = await ormai.executeTool(t.name, args, ctx)
            return JSON.parse(JSON.stringify(result, jsonReplacer))
          } catch (err) {
            return { error: (err as Error).message }
          }
        },
      }),
    ])
  )
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

async function runAgentDemo(
  ctx: DefaultContext,
  userPrompt: string,
  label: string
): Promise<void> {
  console.log(`\n${"=".repeat(64)}`)
  console.log(`DEMO: ${label}`)
  console.log(`Prompt: "${userPrompt}"`)
  console.log("=".repeat(64))

  // loadSchema() is idempotent — cached after first call
  await ormai.loadSchema()
  const ormaiTools = ormai.getTools(ctx) as LLMTool[]

  console.log(`\nTools available to LLM (${ormaiTools.length}): ${ormaiTools.map((t) => t.name).join(", ")}`)

  const { text } = await generateText({
    model: openrouter("openrouter/owl-alpha"),
    tools: buildTools(ormaiTools, ctx),
    maxSteps: 5,
    prompt: userPrompt,
    onStepFinish({ toolCalls, toolResults }) {
      for (const call of toolCalls) {
        console.log(`\n  → ${call.toolName}(${JSON.stringify(call.args)})`)
        const result = toolResults.find((r) => r.toolCallId === call.toolCallId)
        if (result) {
          const preview = JSON.stringify(result.result)
          console.log(`    ${preview}`)
        }
      }
    },
  })

  console.log(`\nAI:\n${text}`)
}

// Serialise Prisma Decimal objects as plain numbers for the LLM
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && "constructor" in value) {
    const ctor = (value as { constructor: { name: string } }).constructor.name
    if (ctor === "Decimal") return Number(value)
  }
  return value
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const prompt = "Give me a summary of all orders. For each delivered order, show me the items purchased."

  // Scenario 1: Admin user — full access within tenant-alpha
  await runAgentDemo(
    { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
    prompt,
    "Admin (alice @ tenant-alpha) — full access"
  )

  // Uncomment to run additional scenarios:

  // Scenario 2: Support user — no customer relation, user_id field stripped, no write tools
  await runAgentDemo(
    { user: { id: "user-bob", role: "support" }, tenant: { id: "tenant-alpha" } },
    prompt,
    "Support (bob @ tenant-alpha) — restricted access"
  )

  // Scenario 3: Admin from another tenant — tenant isolation, sees zero tenant-alpha data
  await runAgentDemo(
    { user: { id: "user-carol", role: "admin" }, tenant: { id: "tenant-beta" } },
    prompt,
    "Admin (carol @ tenant-beta) — cross-tenant isolation"
  )

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  prisma.$disconnect()
  process.exit(1)
})
