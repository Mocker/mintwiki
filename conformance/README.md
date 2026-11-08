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

The write-lane section (M3.2) runs when `CONFORMANCE_SERVICE_CRED`
names a credential registered on the target with ceiling
`/conformance/**` and tiers `allow,approve`. The cross-runtime
section runs when `CONFORMANCE_FOREIGN_TOKEN` holds a token minted
by the *other* runtime under the same signing secret: it must pass
signature verification and be stopped only by the jti registry
("token not minted by this wiki") — the JWT format is portable,
while registry/revocation state is per-instance by design. Owner
steps that are not HTTP on either runtime (proposal accept,
mint-request decide) are covered by each runtime's own test suite.
