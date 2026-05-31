# vistal ecommerce example

Demonstrates vistal's core value: the same LLM agent, the same question, different access context → different data visible.

Three scenarios run back-to-back against a real Postgres database:

| Scenario | User | What changes |
|----------|------|--------------|
| Admin | alice @ tenant-alpha | Full access: all fields, customer relation, write tools |
| Support | bob @ tenant-alpha | No customer relation, `user_id` field stripped, no write tools |
| Cross-tenant | carol @ tenant-beta | Zero results — tenant-alpha data is invisible |

`internal_notes` on orders is marked `@vistal:sensitive` in the schema and is **never** sent to the LLM regardless of role.

## Prerequisites

- Docker
- Node.js 20+
- A Google AI Studio API key (aistudio.google.com)

## Quick start

```bash
# 1. Build the vistal library
cd /path/to/vistal
npm install && npm run build

# 2. Install example dependencies
cd examples/ecommerce
npm install

# 3. Configure environment
cp .env.example .env
# edit .env and set GOOGLE_AI_API_KEY

# 4. Start Postgres, migrate, seed
npm run db:start
npm run db:push   # runs prisma migrate dev (creates tables)
npm run db:generate
npm run db:seed      # inserts fixture data

# 5. Run the demo
npm start
```

## Database scripts

| Script | Description |
|--------|-------------|
| `npm run db:start` | Start Postgres container (or resume if stopped) |
| `npm run db:stop` | Stop container (data preserved) |
| `npm run db:reset` | Wipe and recreate the container |
| `npm run db:migrate` | Apply Prisma migrations |
| `npm run db:seed` | Insert fixture data |
| `npm run db:studio` | Open Prisma Studio |

## Key code sections in `index.ts`

- **Lines 20–55** — policy definitions: where role-based and tenant-based rules are declared
- **Lines 57–110** — `runAgentDemo`: the agentic loop that calls Claude and executes tool calls through vistal
- **Lines 115–135** — `main`: three identical prompts run under three different contexts
