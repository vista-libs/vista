import "dotenv/config"
import { PrismaClient, UserRole, OrderStatus } from "@prisma/client"

const prisma = new PrismaClient()

async function main() {
  // Delete in dependency order for idempotency
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.product.deleteMany()
  await prisma.user.deleteMany()

  // Users
  const alice = await prisma.user.create({
    data: {
      id: "user-alice",
      name: "Alice Admin",
      email: "alice@alpha.com",
      password_hash: "$2b$10$hashed_alice",
      role: UserRole.admin,
      tenant_id: "tenant-alpha",
    },
  })

  const bob = await prisma.user.create({
    data: {
      id: "user-bob",
      name: "Bob Support",
      email: "bob@alpha.com",
      password_hash: "$2b$10$hashed_bob",
      role: UserRole.support,
      tenant_id: "tenant-alpha",
    },
  })

  await prisma.user.create({
    data: {
      id: "user-carol",
      name: "Carol Admin",
      email: "carol@beta.com",
      password_hash: "$2b$10$hashed_carol",
      role: UserRole.admin,
      tenant_id: "tenant-beta",
    },
  })

  // Products (tenant-alpha only)
  const laptop = await prisma.product.create({
    data: {
      id: "prod-laptop",
      name: "Pro Laptop",
      description: "High-performance laptop",
      price: 129999,
      stock: 10,
      tenant_id: "tenant-alpha",
    },
  })

  const headset = await prisma.product.create({
    data: {
      id: "prod-headset",
      name: "Studio Headset",
      description: "Professional audio headset",
      price: 24999,
      stock: 0,
      tenant_id: "tenant-alpha",
    },
  })

  await prisma.product.create({
    data: {
      id: "prod-keyboard",
      name: "Mechanical Keyboard",
      description: "Tactile mechanical keyboard",
      price: 14999,
      stock: 25,
      tenant_id: "tenant-alpha",
    },
  })

  await prisma.product.create({
    data: {
      id: "prod-mouse",
      name: "Wireless Mouse",
      description: "Ergonomic wireless mouse",
      price: 7999,
      stock: 42,
      tenant_id: "tenant-alpha",
    },
  })

  // Orders with items (tenant-alpha only)
  // Order 1: alice's delivered order — has internal_notes to prove they never leak
  const order1 = await prisma.order.create({
    data: {
      id: "order-1",
      status: OrderStatus.delivered,
      total: 154998,
      internal_notes: "Flagged for review — chargeback risk",
      tenant_id: "tenant-alpha",
      user_id: alice.id,
    },
  })

  // Order 2: alice's pending order
  const order2 = await prisma.order.create({
    data: {
      id: "order-2",
      status: OrderStatus.pending,
      total: 129999,
      tenant_id: "tenant-alpha",
      user_id: alice.id,
    },
  })

  // Order 3: bob's processing order
  const order3 = await prisma.order.create({
    data: {
      id: "order-3",
      status: OrderStatus.processing,
      total: 24999,
      tenant_id: "tenant-alpha",
      user_id: bob.id,
    },
  })

  // Order items
  await prisma.orderItem.createMany({
    data: [
      { order_id: order1.id, product_id: laptop.id,  quantity: 1, unit_price: 129999 },
      { order_id: order1.id, product_id: headset.id, quantity: 1, unit_price: 24999 },
      { order_id: order2.id, product_id: laptop.id,  quantity: 1, unit_price: 129999 },
      { order_id: order3.id, product_id: headset.id, quantity: 1, unit_price: 24999 },
    ],
  })

  console.log("Seed complete: 3 users, 4 products, 3 orders, 4 order items")
  console.log("  tenant-alpha: alice (admin), bob (support), 4 products, 3 orders")
  console.log("  tenant-beta:  carol (admin), no data")
}

main()
  .catch((err) => {
    console.error("Seed failed:", err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
