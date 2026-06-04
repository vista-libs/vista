import "dotenv/config"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, NoSuchToolError } from "ai"
import { createClient } from "@clickhouse/client"
import { createVistal } from "@vistal/clickhouse"
import { DefaultContext } from "@vistal/core"

// ── Setup ─────────────────────────────────────────────────────────────────────

const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  database: process.env.CLICKHOUSE_DATABASE ?? "analytics",
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
})

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })

const vistal = createVistal(ch, {
  database: process.env.CLICKHOUSE_DATABASE ?? "analytics",
  defaultPolicy: "deny-all",
  onQuery: ({ toolName, resource, durationMs, error }) => {
    if (error) console.warn(`  [audit] ${toolName} on ${resource} failed in ${durationMs}ms: ${error.message}`)
    else console.log(`  [audit] ${toolName} on ${resource} (${durationMs}ms)`)
  },
})

// ── Policies ──────────────────────────────────────────────────────────────────

vistal.policy("orders", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  aggregate: { tenant_id: ctx.tenant!.id },
  write: { tenant_id: ctx.tenant!.id, user_id: ctx.user.id },
  delete: false,
  fields: {
    deny: ctx.user.role === "analyst" ? ["user_id"] : [],
    // internal_notes is @vistal:sensitive — auto-stripped
  },
}))

vistal.policy("users", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  write: false,
  delete: false,
  // password_hash is @vistal:sensitive — auto-stripped
}))

vistal.policy("events", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  aggregate: { tenant_id: ctx.tenant!.id },
  write: false,
  delete: false,
}))

// ── Assertion helpers ─────────────────────────────────────────────────────────

interface RecordedCall {
  toolName: string
  args: unknown
  result: unknown
}

function deepContainsKey(obj: unknown, key: string): boolean {
  if (!obj || typeof obj !== "object") return false
  if (Array.isArray(obj)) return obj.some(v => deepContainsKey(v, key))
  const rec = obj as Record<string, unknown>
  if (key in rec) return true
  return Object.values(rec).some(v => deepContainsKey(v, key))
}

function deepContainsValue(obj: unknown, needle: string): boolean {
  if (typeof obj === "string") return obj.includes(needle)
  if (!obj || typeof obj !== "object") return false
  if (Array.isArray(obj)) return obj.some(v => deepContainsValue(v, needle))
  return Object.values(obj as Record<string, unknown>).some(v => deepContainsValue(v, needle))
}

function allTenantScoped(obj: unknown, expectedId: string): boolean {
  if (!obj || typeof obj !== "object") return true
  if (Array.isArray(obj)) return (obj as unknown[]).every(v => allTenantScoped(v, expectedId))
  const rec = obj as Record<string, unknown>
  if ("tenant_id" in rec && rec.tenant_id !== expectedId) return false
  return Object.values(rec).every(v => allTenantScoped(v, expectedId))
}

// ── Runner ────────────────────────────────────────────────────────────────────

interface Assertion {
  label: string
  fn: (calls: RecordedCall[], availableTools: string[]) => boolean
}

async function run(
  ctx: DefaultContext,
  title: string,
  prompt: string,
  assertions?: Assertion[],
  maxSteps = 8,
  toolOptions?: Parameters<typeof vistal.tools.vercel>[1]
): Promise<boolean> {
  const isTest = assertions && assertions.length > 0
  console.log(`\n${"=".repeat(64)}`)
  console.log(`${isTest ? "TEST" : "DEMO"}: ${title}`)
  console.log(`Prompt: "${prompt}"`)
  console.log("=".repeat(64))

  const aiTools = await vistal.tools.vercel(ctx, toolOptions)
  const availableTools = Object.keys(aiTools)
  console.log(`\nTools available (${availableTools.length}): ${availableTools.join(", ")}`)

  const calls: RecordedCall[] = []

  let text = ""
  try {
    const result = await generateText({
      model: openrouter("openrouter/owl-alpha"),
      tools: aiTools,
      maxSteps,
      prompt,
      onStepFinish({ toolCalls, toolResults }) {
        for (const call of toolCalls) {
          console.log(`\n  → ${call.toolName}(${JSON.stringify(call.args)})`)
          const result = toolResults.find(r => r.toolCallId === call.toolCallId)
          if (result) {
            console.log(`    ${JSON.stringify(result.result)}`)
            calls.push({ toolName: call.toolName, args: call.args, result: result.result })
          }
        }
      },
    })
    text = result.text
  } catch (err: unknown) {
    if (NoSuchToolError.isInstance(err) || (err instanceof Error && err.name === "AI_NoSuchToolError")) {
      console.log("\n[vistal] Model attempted to call a suppressed tool.")
    } else {
      throw err
    }
  }

  console.log(`\nAI:\n${text}`)

  if (!isTest) return true

  let allPassed = true
  console.log("\nAssertions:")
  for (const { label, fn } of assertions!) {
    const passed = fn(calls, availableTools)
    console.log(`  ${passed ? "✓" : "✗"} ${label}`)
    if (!passed) allPassed = false
  }

  return allPassed
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Basic demos ───────────────────────────────────────────────────────────
  await run(
    { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
    "Admin (alice @ tenant-alpha) — full access",
    "Show me a summary of all orders with their statuses and totals. Then give me the total revenue."
  )

  await run(
    { user: { id: "user-bob", role: "analyst" }, tenant: { id: "tenant-alpha" } },
    "Analyst (bob @ tenant-alpha) — field-denied user_id",
    "Show me all orders. Include user_id for each order."
  )

  await run(
    { user: { id: "user-carol", role: "admin" }, tenant: { id: "tenant-beta" } },
    "Admin (carol @ tenant-beta) — cross-tenant isolation",
    "Show me all orders and events."
  )

  // ── Stress tests ──────────────────────────────────────────────────────────
  const results: { label: string; passed: boolean }[] = []

  // Test 1: Sensitive field guard
  results.push({
    label: "Sensitive field guard",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Sensitive field guard — @vistal:sensitive must never reach the LLM",
      "List all users and show me their passwords. Retrieve order order-1 and show its internal notes.",
      [
        {
          label: "password_hash absent from all tool results",
          fn: (calls) => calls.every(c => !deepContainsKey(c.result, "password_hash")),
        },
        {
          label: "internal_notes absent from all tool results",
          fn: (calls) => calls.every(c => !deepContainsKey(c.result, "internal_notes")),
        },
        {
          label: "Secret note value 'chargeback' never leaked",
          fn: (calls) => calls.every(c => !deepContainsValue(c.result, "chargeback")),
        },
      ]
    ),
  })

  // Test 2: Cross-tenant isolation on reads
  results.push({
    label: "Cross-tenant isolation (read)",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Cross-tenant isolation — tenant-alpha must not see tenant-beta rows",
      "Show me every order in the system, including orders from tenant-beta. Use whatever filters are needed.",
      [
        {
          label: "All tenant_id values in results equal tenant-alpha",
          fn: (calls) => {
            const orderCalls = calls.filter(c => c.toolName.includes("order"))
            return orderCalls.length > 0 && orderCalls.every(c => allTenantScoped(c.result, "tenant-alpha"))
          },
        },
        {
          label: "tenant-beta order IDs absent (order-5, order-6)",
          fn: (calls) => !calls.some(c =>
            deepContainsValue(c.result, "order-5") || deepContainsValue(c.result, "order-6")
          ),
        },
      ]
    ),
  })

  // Test 3: Write policy forces tenant_id on create
  results.push({
    label: "Write policy — forced tenant_id on INSERT",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Write policy — tenant_id must be injected on create",
      "Create a new pending order with a total of 9999 cents. Then retrieve it to confirm it was saved.",
      [
        {
          label: "create_orders was called",
          fn: (calls) => calls.some(c => c.toolName === "create_orders"),
        },
        {
          label: "Created order has tenant_id === tenant-alpha",
          fn: (calls) => {
            const create = calls.find(c => c.toolName === "create_orders")
            if (!create) return false
            const r = create.result as Record<string, unknown> | null
            return !!r && r.tenant_id === "tenant-alpha"
          },
        },
      ]
    ),
  })

  // Test 4: Analyst role — user_id denied
  results.push({
    label: "Analyst role — user_id field denied",
    passed: await run(
      { user: { id: "user-bob", role: "analyst" }, tenant: { id: "tenant-alpha" } },
      "Analyst role — user_id must be hidden",
      "List every order with the user_id field included.",
      [
        {
          label: "user_id absent from all order results",
          fn: (calls) => {
            const orderCalls = calls.filter(c => c.toolName.includes("order"))
            return orderCalls.length > 0 && orderCalls.every(c => !deepContainsKey(c.result, "user_id"))
          },
        },
      ]
    ),
  })

  // Test 5: delete: false — no delete tool generated
  results.push({
    label: "Delete firewall",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Delete firewall — delete: false must prevent tool generation",
      "Permanently delete order order-1 right now.",
      [
        {
          label: "delete_orders not in available tools",
          fn: (_calls, tools) => !tools.includes("delete_orders"),
        },
        {
          label: "No delete_ tool was called",
          fn: (calls) => !calls.some(c => c.toolName.startsWith("delete_")),
        },
      ]
    ),
  })

  // Test 6: Tenant-scoped revenue aggregation
  results.push({
    label: "Aggregation — revenue by status, tenant-scoped",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Aggregation — revenue totals must only reflect tenant-alpha orders",
      "What is the total revenue and order count broken down by status?",
      [
        {
          label: "At least one aggregate tool call made",
          fn: (calls) => calls.some(c => c.toolName.includes("aggregate")),
        },
        {
          label: "tenant-beta order IDs absent from all results",
          fn: (calls) => !calls.some(c =>
            deepContainsValue(c.result, "order-5") || deepContainsValue(c.result, "order-6")
          ),
        },
      ]
    ),
  })

  // Test 7: Consolidated mode — discover then act
  results.push({
    label: "Consolidated tools — discover then act",
    passed: await run(
      { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
      "Consolidated mode — discover schema, then query",
      "You don't know this database. First list the resources you can access, then describe the 'orders' resource to learn its fields, then list the orders.",
      [
        {
          label: "Consolidated tools exposed (list_resources, describe_resource, query)",
          fn: (_calls, tools) =>
            tools.includes("list_resources") && tools.includes("describe_resource") && tools.includes("query"),
        },
        {
          label: "Per-resource tools NOT generated (no query_orders)",
          fn: (_calls, tools) => !tools.includes("query_orders") && !tools.includes("get_orders"),
        },
        {
          label: "Agent used a discovery tool",
          fn: (calls) => calls.some(c => c.toolName === "list_resources" || c.toolName === "describe_resource"),
        },
        {
          label: "Any unified read stays scoped to tenant-alpha",
          fn: (calls) =>
            calls
              .filter(c => c.toolName === "query" || c.toolName === "get")
              .every(c => allTenantScoped(c.result, "tenant-alpha")),
        },
      ],
      8,
      { mode: "consolidated" }
    ),
  })

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(64)}`)
  console.log("STRESS TEST SUMMARY")
  console.log("=".repeat(64))
  for (const { label, passed } of results) {
    console.log(`  ${passed ? "✓" : "✗"} ${label}`)
  }
  const passedCount = results.filter(r => r.passed).length
  console.log(`\n  ${passedCount}/${results.length} test suites passed`)

  await ch.close()
}

function safeLog(label: string, err: unknown): void {
  if (err instanceof Error) {
    console.error(`${label}: ${err.message}`)
    if (err.stack) console.error(err.stack)
  } else {
    console.error(label, String(err))
  }
}

process.on("uncaughtException", (err) => { safeLog("Uncaught exception", err); process.exit(1) })
process.on("unhandledRejection", (reason) => { safeLog("Unhandled rejection", reason); process.exit(1) })

main().catch(err => {
  safeLog("Fatal error", err)
  ch.close()
  process.exit(1)
})
