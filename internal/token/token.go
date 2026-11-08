// Package token implements MintWiki's edit tokens: HMAC-signed JWTs minted
// by the owner, carrying an enumerated scope (one tool + path prefixes), a
// tier (allow | approve), a unique jti for revocation, and a short expiry.
// There is exactly one signing secret, with exactly one purpose — no
// fallback chain.
package token

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	Issuer   = "mintwiki"
	Audience = "mintwiki"
	ToolEdit = "edit_page"

	TierAllow   = "allow"
	TierApprove = "approve"
)

// Claims is the token payload. RegisteredClaims carries jti (ID), expiry,
// issuer and audience.
type Claims struct {
	jwt.RegisteredClaims
	Tool  string   `json:"tool"`
	Paths []string `json:"paths"`
	Tier  string   `json:"tier"`
	Actor string   `json:"actor"`
}

// ScopeString renders the scope compactly for receipts and listings.
func (c *Claims) ScopeString() string {
	return c.Tool + ":" + strings.Join(c.Paths, ",")
}

// CoversPath reports whether any of the token's path patterns covers the
// given wiki path. Patterns: "/projects/**" (prefix), "/projects/demo"
// (exact), "/**" (everything).
func (c *Claims) CoversPath(path string) bool {
	for _, pat := range c.Paths {
		if matchPattern(pat, path) {
			return true
		}
	}
	return false
}

func matchPattern(pattern, path string) bool {
	pattern = strings.TrimPrefix(pattern, "/")
	path = strings.TrimPrefix(path, "/")
	if pattern == "**" {
		return true
	}
	if strings.HasSuffix(pattern, "/**") {
		prefix := strings.TrimSuffix(pattern, "/**")
		return path == prefix || strings.HasPrefix(path, prefix+"/")
	}
	return pattern == path
}

func newJTI() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// Mint creates a signed token. It does not register the jti — the caller
// (the minter) records it in the store so it can later be revoked.
func Mint(key []byte, actor, tool string, paths []string, tier string, ttl time.Duration) (string, *Claims, error) {
	if tool != ToolEdit {
		return "", nil, fmt.Errorf("unknown tool %q", tool)
	}
	if tier != TierAllow && tier != TierApprove {
		return "", nil, fmt.Errorf("unknown tier %q", tier)
	}
	if len(paths) == 0 {
		return "", nil, errors.New("token needs at least one path pattern")
	}
	now := time.Now()
	claims := &Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    Issuer,
			Audience:  jwt.ClaimStrings{Audience},
			ID:        newJTI(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
		Tool:  tool,
		Paths: paths,
		Tier:  tier,
		Actor: actor,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString(key)
	if err != nil {
		return "", nil, err
	}
	return signed, claims, nil
}

// Parse verifies signature, issuer, audience and expiry, in that order.
// Revocation and scope are checked separately by the caller (they need the
// store), keeping the verification order explicit at the call site.
func Parse(key []byte, tokenStr string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
		}
		return key, nil
	},
		jwt.WithIssuer(Issuer),
		jwt.WithAudience(Audience),
		jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return nil, err
	}
	return claims, nil
}
