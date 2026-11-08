// Package store implements MintWiki's storage core: immutable
// content-addressed revision files on disk plus a SQLite manifest holding
// the only mutable state — one head pointer per page, moved by
// compare-and-swap inside a transaction.
package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ErrConflict is returned when a CAS write finds the head has moved.
var ErrConflict = errors.New("head conflict")

// ErrNotFound is returned when a page or proposal does not exist.
var ErrNotFound = errors.New("not found")

type Store struct {
	dataDir string
	db      *sql.DB
}

type Page struct {
	Path    string
	RevID   string
	Version int64
	Content []byte
}

type Proposal struct {
	ID         string
	PagePath   string
	RevID      string
	BaseVer    int64
	Status     string
	TokenJTI   string
	CreatedAt  string
	Content    []byte
}

// Open creates the data directory layout and the SQLite schema if needed.
func Open(dataDir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dataDir, "revisions"), 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "pages"), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dataDir, "mintwiki.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // serialize writers; CAS stays meaningful
	s := &Store{dataDir: dataDir, db: db}
	if _, err := db.Exec(`PRAGMA journal_mode=WAL`); err != nil {
		return nil, err
	}
	_, err = db.Exec(`
CREATE TABLE IF NOT EXISTS pages (
  path TEXT PRIMARY KEY,
  head_rev TEXT NOT NULL,
  head_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  rev_id TEXT PRIMARY KEY,
  page_path TEXT NOT NULL,
  parent_rev TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  token_jti TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  jti TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT '',
  exp INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  page_path TEXT NOT NULL,
  rev_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  token_jti TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS services (
  name TEXT PRIMARY KEY,
  cred_hash TEXT NOT NULL,
  ceiling_paths TEXT NOT NULL DEFAULT '',
  tiers TEXT NOT NULL DEFAULT '',
  max_ttl_seconds INTEGER NOT NULL DEFAULT 1800,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);`)
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// WriteRevision stores content as an immutable revision object — a plain
// Markdown file named by its content hash — and returns the hash.
// Writing the same content twice is a no-op.
func (s *Store) WriteRevision(content []byte) (string, error) {
	sum := sha256.Sum256(content)
	id := hex.EncodeToString(sum[:])
	dir := filepath.Join(s.dataDir, "revisions", id[:2])
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	p := filepath.Join(dir, id+".md")
	if _, err := os.Stat(p); err == nil {
		return id, nil
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, p); err != nil {
		return "", err
	}
	return id, nil
}

// ReadRevision returns the content of an immutable revision object.
func (s *Store) ReadRevision(revID string) ([]byte, error) {
	if len(revID) < 2 {
		return nil, ErrNotFound
	}
	b, err := os.ReadFile(filepath.Join(s.dataDir, "revisions", revID[:2], revID+".md"))
	if err != nil {
		return nil, ErrNotFound
	}
	return b, nil
}

// PageFilePath is where a page's current head lives as a plain Markdown
// file (data/pages/<path>.md) — readable and editable with any tool.
func (s *Store) PageFilePath(path string) string {
	return filepath.Join(s.dataDir, "pages", filepath.FromSlash(path)+".md")
}

// mirrorHead writes the page's current head content to its .md file.
// The mirror is a materialized view of the store, kept in step on every
// head move; the store (revisions + SQLite heads) stays the source of
// truth and the mirror can always be regenerated from it.
func (s *Store) mirrorHead(path string, content []byte) error {
	p := s.PageFilePath(path)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// GetPage returns the page at its current head.
func (s *Store) GetPage(path string) (*Page, error) {
	var rev string
	var ver int64
	err := s.db.QueryRow(`SELECT head_rev, head_version FROM pages WHERE path=?`, path).Scan(&rev, &ver)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	content, err := s.ReadRevision(rev)
	if err != nil {
		return nil, err
	}
	return &Page{Path: path, RevID: rev, Version: ver, Content: content}, nil
}

// HeadVersion returns the page's current head version (0 if the page does
// not exist).
func (s *Store) HeadVersion(path string) (int64, error) {
	var ver int64
	err := s.db.QueryRow(`SELECT head_version FROM pages WHERE path=?`, path).Scan(&ver)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return ver, err
}

// ListPages returns all page paths, sorted.
func (s *Store) ListPages() ([]string, error) {
	rows, err := s.db.Query(`SELECT path FROM pages ORDER BY path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// PutPage writes content as a new revision and moves the head by CAS:
// the caller names the head version it based its edit on; if the head has
// moved, the write is rejected with ErrConflict and the current version.
func (s *Store) PutPage(path string, content []byte, expectedVersion int64, author, jti string) (revID string, newVersion int64, currentVersion int64, err error) {
	revID, err = s.WriteRevision(content)
	if err != nil {
		return "", 0, 0, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", 0, 0, err
	}
	defer tx.Rollback()

	var curRev string
	var curVer int64
	qerr := tx.QueryRow(`SELECT head_rev, head_version FROM pages WHERE path=?`, path).Scan(&curRev, &curVer)
	exists := !errors.Is(qerr, sql.ErrNoRows)
	if qerr != nil && exists {
		return "", 0, 0, qerr
	}
	if !exists {
		curVer = 0
	}
	if curVer != expectedVersion {
		return "", 0, curVer, ErrConflict
	}
	newVersion = curVer + 1
	if exists {
		if _, err := tx.Exec(`UPDATE pages SET head_rev=?, head_version=? WHERE path=? AND head_version=?`,
			revID, newVersion, path, curVer); err != nil {
			return "", 0, curVer, err
		}
	} else {
		if _, err := tx.Exec(`INSERT INTO pages(path, head_rev, head_version) VALUES(?,?,?)`,
			path, revID, newVersion); err != nil {
			return "", 0, curVer, err
		}
	}
	if _, err := tx.Exec(`INSERT OR IGNORE INTO revisions(rev_id, page_path, parent_rev, author, token_jti, created_at)
		VALUES(?,?,?,?,?,?)`, revID, path, curRev, author, jti, now()); err != nil {
		return "", 0, curVer, err
	}
	if err := tx.Commit(); err != nil {
		return "", 0, curVer, err
	}
	if err := s.mirrorHead(path, content); err != nil {
		return "", 0, curVer, fmt.Errorf("head moved to %s but page mirror failed: %w", revID, err)
	}
	return revID, newVersion, curVer, nil
}

// AddProposal stores an approve-tier edit as a pending proposal. The head
// does not move.
func (s *Store) AddProposal(path string, content []byte, baseVersion int64, jti string) (string, error) {
	revID, err := s.WriteRevision(content)
	if err != nil {
		return "", err
	}
	cur, err := s.HeadVersion(path)
	if err != nil {
		return "", err
	}
	if cur != baseVersion {
		return "", ErrConflict
	}
	id := fmt.Sprintf("prop-%s-%d", revID[:8], time.Now().UnixNano())
	if _, err := s.db.Exec(`INSERT INTO proposals(id, page_path, rev_id, base_version, status, token_jti, created_at)
		VALUES(?,?,?,?,'pending',?,?)`, id, path, revID, baseVersion, jti, now()); err != nil {
		return "", err
	}
	if _, err := s.db.Exec(`INSERT OR IGNORE INTO revisions(rev_id, page_path, parent_rev, author, token_jti, created_at)
		VALUES(?,?,'','',?,?)`, revID, path, jti, now()); err != nil {
		return "", err
	}
	return id, nil
}

// GetProposal loads a proposal including its content.
func (s *Store) GetProposal(id string) (*Proposal, error) {
	p := &Proposal{}
	err := s.db.QueryRow(`SELECT id, page_path, rev_id, base_version, status, token_jti, created_at
		FROM proposals WHERE id=?`, id).
		Scan(&p.ID, &p.PagePath, &p.RevID, &p.BaseVer, &p.Status, &p.TokenJTI, &p.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	p.Content, err = s.ReadRevision(p.RevID)
	if err != nil {
		return nil, err
	}
	return p, nil
}

// ListProposals returns proposals with the given status ("" = all).
func (s *Store) ListProposals(status string) ([]*Proposal, error) {
	q := `SELECT id, page_path, rev_id, base_version, status, token_jti, created_at FROM proposals`
	if status != "" {
		q += ` WHERE status='` + status + `'`
	}
	q += ` ORDER BY created_at`
	rows, err := s.db.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Proposal
	for rows.Next() {
		p := &Proposal{}
		if err := rows.Scan(&p.ID, &p.PagePath, &p.RevID, &p.BaseVer, &p.Status, &p.TokenJTI, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// AcceptProposal moves the head to the proposal's revision, by CAS against
// the proposal's base version, and marks the proposal accepted.
func (s *Store) AcceptProposal(id, author string) (newVersion int64, currentVersion int64, err error) {
	p, err := s.GetProposal(id)
	if err != nil {
		return 0, 0, err
	}
	if p.Status != "pending" {
		return 0, 0, fmt.Errorf("proposal %s is %s", id, p.Status)
	}
	_, newVersion, currentVersion, err = s.PutPage(p.PagePath, p.Content, p.BaseVer, author, p.TokenJTI)
	if err != nil {
		return 0, currentVersion, err
	}
	if _, err := s.db.Exec(`UPDATE proposals SET status='accepted' WHERE id=?`, id); err != nil {
		return 0, currentVersion, err
	}
	return newVersion, currentVersion, nil
}

// RegisterToken records a minted token's jti so it can be revoked.
func (s *Store) RegisterToken(jti, scope, tier string, exp int64) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO tokens(jti, scope, tier, exp, revoked) VALUES(?,?,?,?,0)`,
		jti, scope, tier, exp)
	return err
}

// RevokeToken marks a jti revoked. Revoked tokens fail verification
// immediately, regardless of expiry.
func (s *Store) RevokeToken(jti string) error {
	res, err := s.db.Exec(`UPDATE tokens SET revoked=1 WHERE jti=?`, jti)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// Unknown jti: record the revocation anyway (defense in depth).
		_, err = s.db.Exec(`INSERT INTO tokens(jti, revoked) VALUES(?,1)`, jti)
		return err
	}
	return nil
}

// IsRevoked reports whether a jti has been revoked.
func (s *Store) IsRevoked(jti string) (bool, error) {
	var revoked int
	err := s.db.QueryRow(`SELECT revoked FROM tokens WHERE jti=?`, jti).Scan(&revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil // unregistered jti: not revoked, but see RegisterToken
	}
	if err != nil {
		return false, err
	}
	return revoked == 1, nil
}

// IsRegistered reports whether a jti was minted by this wiki's minter.
func (s *Store) IsRegistered(jti string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM tokens WHERE jti=?`, jti).Scan(&n)
	return n > 0, err
}

// HashCredential is how service credentials are stored: the raw
// credential is shown to the owner exactly once (at `service add`) and
// never persisted; only this SHA-256 hash is.
func HashCredential(cred string) string {
	sum := sha256.Sum256([]byte(cred))
	return hex.EncodeToString(sum[:])
}

// Service is a registered minting client: a long-lived credential (only
// its hash is stored) that the service exchanges at the mint endpoint for
// short-lived edit tokens, bounded by a scope ceiling the owner set.
type Service struct {
	Name           string
	CredHash       string
	CeilingPaths   []string
	Tiers          []string
	MaxTTLSeconds  int64
	Revoked        bool
	CreatedAt      string
}

// RegisterService adds (or replaces) a service credential + ceiling.
func (s *Store) RegisterService(name, credHash string, ceilingPaths, tiers []string, maxTTLSeconds int64) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO services(name, cred_hash, ceiling_paths, tiers, max_ttl_seconds, revoked, created_at)
		VALUES(?,?,?,?,?,0,?)`, name, credHash, strings.Join(ceilingPaths, ","), strings.Join(tiers, ","), maxTTLSeconds, now())
	return err
}

// GetServiceByHash looks a service up by its credential hash (the raw
// credential is never stored).
func (s *Store) GetServiceByHash(credHash string) (*Service, error) {
	svc := &Service{}
	var paths, tiers string
	var revoked int
	err := s.db.QueryRow(`SELECT name, cred_hash, ceiling_paths, tiers, max_ttl_seconds, revoked, created_at
		FROM services WHERE cred_hash=?`, credHash).
		Scan(&svc.Name, &svc.CredHash, &paths, &tiers, &svc.MaxTTLSeconds, &revoked, &svc.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if paths != "" {
		svc.CeilingPaths = strings.Split(paths, ",")
	}
	if tiers != "" {
		svc.Tiers = strings.Split(tiers, ",")
	}
	svc.Revoked = revoked == 1
	return svc, nil
}

// RevokeService disables a service credential immediately.
func (s *Store) RevokeService(name string) error {
	_, err := s.db.Exec(`UPDATE services SET revoked=1 WHERE name=?`, name)
	return err
}

// ListServices returns all registered services (hashes not included in
// String output by callers; the struct is for internal use).
func (s *Store) ListServices() ([]*Service, error) {
	rows, err := s.db.Query(`SELECT name, cred_hash, ceiling_paths, tiers, max_ttl_seconds, revoked, created_at FROM services ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Service
	for rows.Next() {
		svc := &Service{}
		var paths, tiers string
		var revoked int
		if err := rows.Scan(&svc.Name, &svc.CredHash, &paths, &tiers, &svc.MaxTTLSeconds, &revoked, &svc.CreatedAt); err != nil {
			return nil, err
		}
		if paths != "" {
			svc.CeilingPaths = strings.Split(paths, ",")
		}
		if tiers != "" {
			svc.Tiers = strings.Split(tiers, ",")
		}
		svc.Revoked = revoked == 1
		out = append(out, svc)
	}
	return out, rows.Err()
}

// NormalizePath cleans a wiki path: no leading slash, no empty segments,
// no traversal.
func NormalizePath(p string) (string, error) {
	p = strings.TrimPrefix(strings.TrimSpace(p), "/")
	if p == "" {
		return "", errors.New("empty path")
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", fmt.Errorf("invalid path segment in %q", p)
		}
	}
	return p, nil
}
