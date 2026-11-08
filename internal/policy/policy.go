// Package policy loads MintWiki's local policy file. Policy is checked at
// request time; tokens carry scope, but the wiki's own caps (e.g. maximum
// token lifetime) live here, in a file the owner controls.
package policy

import (
	"encoding/json"
	"errors"
	"os"
	"time"
)

type Policy struct {
	MaxTTLSeconds     int64 `json:"max_ttl_seconds"`
	DefaultTTLSeconds int64 `json:"default_ttl_seconds"`
}

func Default() Policy {
	return Policy{MaxTTLSeconds: 3600, DefaultTTLSeconds: 1800}
}

// Load reads the policy file; a missing file yields the default policy.
func Load(path string) (Policy, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Default(), nil
	}
	if err != nil {
		return Policy{}, err
	}
	p := Default()
	if err := json.Unmarshal(b, &p); err != nil {
		return Policy{}, err
	}
	if p.MaxTTLSeconds <= 0 || p.DefaultTTLSeconds <= 0 {
		return Policy{}, errors.New("policy TTLs must be positive")
	}
	return p, nil
}

// WriteDefault writes the default policy file if none exists.
func WriteDefault(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	b, err := json.MarshalIndent(Default(), "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// CheckTTL enforces the policy cap on a requested token lifetime.
func (p Policy) CheckTTL(ttl time.Duration) error {
	if ttl <= 0 {
		return errors.New("ttl must be positive")
	}
	if ttl > time.Duration(p.MaxTTLSeconds)*time.Second {
		return errors.New("ttl exceeds policy maximum")
	}
	return nil
}

// DefaultTTL is the lifetime used when a mint request names none.
func (p Policy) DefaultTTL() time.Duration {
	return time.Duration(p.DefaultTTLSeconds) * time.Second
}
