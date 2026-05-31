import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@vistal/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@vistal/prisma": path.resolve(__dirname, "packages/prisma/src/index.ts"),
    },
  },
})
