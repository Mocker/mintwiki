import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // The suites exercise ONE shared wiki instance (isolatedStorage
    // is off, below) — three scenario scripts against a single wiki,
    // like the real thing. Running files in parallel would race the
    // shared page index, so they run sequentially.
    fileParallelism: false,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        // Isolated storage can't snapshot a SQLite-backed Durable
        // Object (the pool trips over the WAL -shm file), so tests
        // share one instance and are written to be order-tolerant —
        // the same property the idempotent seed gives the real wiki.
        isolatedStorage: false,
        miniflare: {
          bindings: {
            // Test-only signing secret (64 hex chars = the Go
            // runtime's signing.key format). Never a real key.
            SIGNING_SECRET: "abababababababababababababababababababababababababababababababab",
            // Test-only admin token for the /v1/admin/* surface.
            OWNER_ADMIN_TOKEN: "mintwiki-test-admin-token",
          },
        },
      },
    },
  },
});
