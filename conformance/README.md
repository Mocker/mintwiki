# Conformance

Black-box HTTP checks that every MintWiki runtime must pass — the Go
binary and the Cloudflare Worker alike (Milestone 3 scope, §5).

```sh
# against a seeded Go server
node conformance/run.mjs --base http://localhost:8090
# against wrangler dev
node conformance/run.mjs --base http://localhost:8787
```

The target must already be seeded with `deploy/seed`. Sections are
ported from `scripts/demo.sh` as milestones land; both runtimes must
stay green.
