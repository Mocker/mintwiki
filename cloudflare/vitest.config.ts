import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        // Isolated storage can't snapshot a SQLite-backed Durable
        // Object (the pool trips over the WAL -shm file), so tests
        // share one instance and are written to be order-tolerant —
        // the same property the idempotent seed gives the real wiki.
        isolatedStorage: false,
      },
    },
  },
});
