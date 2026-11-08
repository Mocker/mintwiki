// MintWiki: a wiki where humans and agents edit under narrow scoped,
// short-lived tokens. One Go binary, one data directory.
//
// Usage:
//
//	mintwiki init   --data DIR
//	mintwiki serve  --data DIR --addr :8090
//	mintwiki build  --data DIR [--out DIR]
//	mintwiki mint   --data DIR --actor NAME --paths /projects/** --tier allow --ttl 30m
//	mintwiki revoke --data DIR --jti JTI
//	mintwiki service add --data DIR --name anna --ceiling /projects/** --tiers allow --max-ttl 30m
//	mintwiki service list --data DIR
//	mintwiki service revoke --data DIR --name anna
//	mintwiki mint-requests --data DIR
//	mintwiki approve-request --data DIR --id ID
//	mintwiki deny-request --data DIR --id ID
//	mintwiki proposals --data DIR
//	mintwiki accept --data DIR --proposal ID
//	mintwiki verify-receipts --data DIR
//	mintwiki tools
package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Mocker/mintwiki/internal/policy"
	"github.com/Mocker/mintwiki/internal/receipts"
	"github.com/Mocker/mintwiki/internal/site"
	"github.com/Mocker/mintwiki/internal/store"
	"github.com/Mocker/mintwiki/internal/token"
	"github.com/Mocker/mintwiki/internal/tools"
	"github.com/Mocker/mintwiki/internal/web"
)

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "mintwiki:", err)
	os.Exit(1)
}

func dataFlag(fs *flag.FlagSet) *string {
	return fs.String("data", "data", "data directory")
}

func keyPath(data string) string { return filepath.Join(data, "signing.key") }

// loadOrCreateKey returns the wiki's single-purpose signing key, creating
// it (0600) on first init. Whoever holds this file can mint tokens: it is
// the owner capability, and it never leaves the server.
func loadOrCreateKey(data string) ([]byte, error) {
	p := keyPath(data)
	b, err := os.ReadFile(p)
	if err == nil {
		raw, err := hex.DecodeString(strings.TrimSpace(string(b)))
		if err != nil || len(raw) < 16 {
			return nil, fmt.Errorf("signing key file %s is corrupt", p)
		}
		return raw, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(data, 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(p, []byte(hex.EncodeToString(raw)), 0o600); err != nil {
		return nil, err
	}
	return raw, nil
}

func openAll(data string) (*store.Store, *receipts.Log, []byte, policy.Policy, error) {
	st, err := store.Open(data)
	if err != nil {
		return nil, nil, nil, policy.Policy{}, err
	}
	rl, err := receipts.Open(filepath.Join(data, "receipts.log"))
	if err != nil {
		return nil, nil, nil, policy.Policy{}, err
	}
	key, err := loadOrCreateKey(data)
	if err != nil {
		return nil, nil, nil, policy.Policy{}, err
	}
	pol, err := policy.Load(filepath.Join(data, "policy.json"))
	if err != nil {
		return nil, nil, nil, policy.Policy{}, err
	}
	return st, rl, key, pol, nil
}

func cmdInit(args []string) {
	fs := flag.NewFlagSet("init", flag.ExitOnError)
	data := dataFlag(fs)
	fs.Parse(args)
	st, _, _, _, err := openAll(*data)
	if err != nil {
		fatal(err)
	}
	defer st.Close()
	if err := policy.WriteDefault(filepath.Join(*data, "policy.json")); err != nil {
		fatal(err)
	}
	fmt.Println("initialized data directory:", *data)
}

func siteDir(data string) string { return filepath.Join(data, "site") }

func cmdServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	data := dataFlag(fs)
	addr := fs.String("addr", ":8090", "listen address")
	fs.Parse(args)
	st, rl, key, pol, err := openAll(*data)
	if err != nil {
		fatal(err)
	}
	defer st.Close()
	if err := policy.WriteDefault(filepath.Join(*data, "policy.json")); err != nil {
		fatal(err)
	}
	if _, err := site.Build(st, siteDir(*data)); err != nil {
		fatal(err)
	}
	fmt.Println("mintwiki serving on", *addr, "data:", *data)
	fatal(http.ListenAndServe(*addr, web.New(st, rl, key, siteDir(*data), pol).Handler()))
}

func cmdBuild(args []string) {
	fs := flag.NewFlagSet("build", flag.ExitOnError)
	data := dataFlag(fs)
	out := fs.String("out", "", "output directory (default: <data>/site)")
	fs.Parse(args)
	st, _, _, _, err := openAll(*data)
	if err != nil {
		fatal(err)
	}
	defer st.Close()
	target := *out
	if target == "" {
		target = siteDir(*data)
	}
	n, err := site.Build(st, target)
	if err != nil {
		fatal(err)
	}
	fmt.Printf("built %d page(s) into %s\n", n, target)
}

func cmdMint(args []string) {
	fs := flag.NewFlagSet("mint", flag.ExitOnError)
	data := dataFlag(fs)
	actor := fs.String("actor", "owner", "who the token is for")
	paths := fs.String("paths", "/**", "comma-separated path patterns, e.g. /projects/**")
	tier := fs.String("tier", token.TierAllow, "allow | approve")
	ttl := fs.Duration("ttl", 0, "token lifetime (default from policy)")
	fs.Parse(args)
	st, _, key, pol, err := openAll(*data)
	if err != nil {
		fatal(err)
	}
	defer st.Close()
	lifetime := *ttl
	if lifetime == 0 {
		lifetime = pol.DefaultTTL()
	}
	if err := pol.CheckTTL(lifetime); err != nil {
		fatal(err)
	}
	patterns := strings.Split(*paths, ",")
	signed, claims, err := token.Mint(key, *actor, token.ToolEdit, patterns, *tier, lifetime)
	if err != nil {
		fatal(err)
	}
	if err := st.RegisterToken(claims.ID, claims.ScopeString(), claims.Tier,
		claims.ExpiresAt.Time.Unix()); err != nil {
		fatal(err)
	}
	fmt.Println("jti:", claims.ID)
	fmt.Println("expires:", claims.ExpiresAt.Time.UTC().Format(time.RFC3339))
	fmt.Println("token:", signed)
}

func cmdRevoke(args []string) {
	fs := flag.NewFlagSet("revoke", flag.ExitOnError)
	data := dataFlag(fs)
	jti := fs.String("jti", "", "token id to revoke")
	fs.Parse(args)
	if *jti == "" {
		fatal(fmt.Errorf("--jti is required"))
	}
	st, _, _, _, err := openAll(*data)
	if err != nil {
		fatal(err)
	}
	defer st.Close()
	if err := st.RevokeToken(*jti); err != nil {
		fatal(err)
	}
	fmt.Println("revoked:", *jti)
}

func cmdProposals(args []string) {
	fs := flag.NewFlagSet("proposals", flag.ExitOnError)
	data := dataFlag(fs)
	fs.Parse(args)
	st, _, _, _, err := openAll(*data)
	if err != nil {
		fatal(err)
	}
	defer st.Close()
	props, err := st.ListProposals("pending")
	if err != nil {
		fatal(err)
	}
	if len(props) == 0 {
		fmt.Println("no pending proposals")
		return
	}
	for _, p := range props {
		fmt.Printf("%s  %s  base_version=%d  by token %s  at %s\n", p.ID, p.PagePath, p.BaseVer, p.TokenJTI, p.CreatedAt)
	}
}

func cmdAccept(args []string) {
	fs := flag.NewFlagSet("accept", flag.ExitOnError)
	data := dataFlag(fs)
	prop := fs.String("proposal", "", "proposal id to accept")
	fs.Parse(args)
	if *prop == "" {
		fatal(fmt.Errorf("--proposal is required"))
	}
	st, rl, _, _, err := openAll(*data)
	if err != nil {
		fatal(err)
	}
	defer st.Close()
	p, err := st.GetProposal(*prop)
	if err != nil {
		fatal(err)
	}
	before, _ := st.HeadVersion(p.PagePath)
	newVer, _, err := st.AcceptProposal(*prop, "owner")
	if err != nil {
		fatal(err)
	}
	if err := rl.Append(receipts.Entry{
		Actor: "owner", TokenJTI: p.TokenJTI, Page: p.PagePath, Result: "accepted",
		ProposalID: p.ID, RevID: p.RevID, BeforeVer: before, AfterVer: newVer,
	}); err != nil {
		fatal(err)
	}
	// The head moved: rebuild the static site so any running server (it
	// serves files from disk) shows the accepted page immediately.
	if _, err := site.Build(st, siteDir(*data)); err != nil {
		fatal(err)
	}
	fmt.Printf("accepted %s: %s now at version %d\n", p.ID, p.PagePath, newVer)
}

func cmdService(args []string) {
	if len(args) < 1 {
		fatal(fmt.Errorf("usage: mintwiki service <add|list|revoke> [flags]"))
	}
	switch args[0] {
	case "add":
		fs := flag.NewFlagSet("service add", flag.ExitOnError)
		data := dataFlag(fs)
		name := fs.String("name", "", "service name (e.g. anna)")
		ceiling := fs.String("ceiling", "", "comma-separated path patterns the service may ever request, e.g. /projects/**")
		tiers := fs.String("tiers", token.TierAllow, "comma-separated tiers the service may request: allow, approve")
		maxTTL := fs.Duration("max-ttl", 30*time.Minute, "maximum token lifetime this service may request")
		fs.Parse(args[1:])
		if *name == "" || *ceiling == "" {
			fatal(fmt.Errorf("--name and --ceiling are required"))
		}
		st, _, _, _, err := openAll(*data)
		if err != nil {
			fatal(err)
		}
		defer st.Close()
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			fatal(err)
		}
		cred := "mwsvc_" + hex.EncodeToString(raw)
		if err := st.RegisterService(*name, store.HashCredential(cred),
			strings.Split(*ceiling, ","), strings.Split(*tiers, ","),
			int64(maxTTL.Seconds())); err != nil {
			fatal(err)
		}
		fmt.Println("service:", *name)
		fmt.Println("credential:", cred)
		fmt.Println("STORE THIS CREDENTIAL NOW — it is shown once; only its hash is kept.")
	case "list":
		fs := flag.NewFlagSet("service list", flag.ExitOnError)
		data := dataFlag(fs)
		fs.Parse(args[1:])
		st, _, _, _, err := openAll(*data)
		if err != nil {
			fatal(err)
		}
		defer st.Close()
		svcs, err := st.ListServices()
		if err != nil {
			fatal(err)
		}
		if len(svcs) == 0 {
			fmt.Println("no services registered")
			return
		}
		for _, svc := range svcs {
			state := "active"
			if svc.Revoked {
				state = "REVOKED"
			}
			fmt.Printf("%s  ceiling=%s  tiers=%s  max_ttl=%ds  %s\n",
				svc.Name, strings.Join(svc.CeilingPaths, ","), strings.Join(svc.Tiers, ","), svc.MaxTTLSeconds, state)
		}
	case "revoke":
		fs := flag.NewFlagSet("service revoke", flag.ExitOnError)
		data := dataFlag(fs)
		name := fs.String("name", "", "service name to revoke")
		fs.Parse(args[1:])
		if *name == "" {
			fatal(fmt.Errorf("--name is required"))
		}
		st, _, _, _, err := openAll(*data)
		if err != nil {
			fatal(err)
		}
		defer st.Close()
		if err := st.RevokeService(*name); err != nil {
			fatal(err)
		}
		fmt.Println("service revoked:", *name)
	default:
		fatal(fmt.Errorf("unknown service subcommand: %s", args[0]))
	}
}

func cmdMintRequests(args []string) {
	fs := flag.NewFlagSet("mint-requests", flag.ExitOnError)
	data := dataFlag(fs)
	fs.Parse(args)
	st, _, _, _, err := openAll(*data)
	if err != nil {
		fatal(err)
	}
	defer st.Close()
	reqs, err := st.ListMintRequests("pending")
	if err != nil {
		fatal(err)
	}
	if len(reqs) == 0 {
		fmt.Println("no pending mint requests")
		return
	}
	for _, m := range reqs {
		fmt.Printf("%s  service=%s  scope=%s:%s  tier=%s  ttl=%ds  requested %s\n",
			m.ID, m.Service, m.Tool, strings.Join(m.Paths, ","), m.Tier, m.TTLSeconds, m.CreatedAt)
	}
}

func cmdDecideRequest(args []string, approve bool) {
	verb := "deny-request"
	if approve {
		verb = "approve-request"
	}
	fs := flag.NewFlagSet(verb, flag.ExitOnError)
	data := dataFlag(fs)
	id := fs.String("id", "", "mint request id")
	fs.Parse(args)
	if *id == "" {
		fatal(fmt.Errorf("--id is required"))
	}
	st, rl, _, _, err := openAll(*data)
	if err != nil {
		fatal(err)
	}
	defer st.Close()
	m, err := st.GetMintRequest(*id)
	if err != nil {
		fatal(err)
	}
	if err := st.DecideMintRequest(*id, approve); err != nil {
		fatal(err)
	}
	result := "mint_request_denied"
	if approve {
		result = "mint_request_approved"
	}
	if err := rl.Append(receipts.Entry{
		Actor: "owner", Scope: m.Tool + ":" + strings.Join(m.Paths, ","),
		Result: result, RequestID: m.ID,
	}); err != nil {
		fatal(err)
	}
	fmt.Printf("%s %s (service %s, scope %s:%s)\n", result, m.ID, m.Service, m.Tool, strings.Join(m.Paths, ","))
}

// cmdTools prints the shared tool definitions as JSON — the same
// definitions the MCP server lists and webmcp.js registers. No data
// directory needed: the definitions are static.
func cmdTools(args []string) {
	b, err := tools.DefinitionJSON()
	if err != nil {
		fatal(err)
	}
	fmt.Println(string(b))
}

func cmdVerifyReceipts(args []string) {
	fs := flag.NewFlagSet("verify-receipts", flag.ExitOnError)
	data := dataFlag(fs)
	fs.Parse(args)
	n, err := receipts.Verify(filepath.Join(*data, "receipts.log"))
	if err != nil {
		fatal(err)
	}
	fmt.Printf("receipt chain OK: %d entries\n", n)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: mintwiki <init|serve|build|mint|revoke|service|mint-requests|approve-request|deny-request|proposals|accept|verify-receipts|tools> [flags]")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "init":
		cmdInit(os.Args[2:])
	case "serve":
		cmdServe(os.Args[2:])
	case "build":
		cmdBuild(os.Args[2:])
	case "mint":
		cmdMint(os.Args[2:])
	case "revoke":
		cmdRevoke(os.Args[2:])
	case "service":
		cmdService(os.Args[2:])
	case "mint-requests":
		cmdMintRequests(os.Args[2:])
	case "approve-request":
		cmdDecideRequest(os.Args[2:], true)
	case "deny-request":
		cmdDecideRequest(os.Args[2:], false)
	case "proposals":
		cmdProposals(os.Args[2:])
	case "accept":
		cmdAccept(os.Args[2:])
	case "verify-receipts":
		cmdVerifyReceipts(os.Args[2:])
	case "tools":
		cmdTools(os.Args[2:])
	default:
		fmt.Fprintln(os.Stderr, "unknown command:", os.Args[1])
		os.Exit(2)
	}
}
