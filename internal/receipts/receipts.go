// Package receipts implements MintWiki's append-only, hash-chained audit
// log. Every write attempt — applied, proposed, or rejected — appends one
// entry whose hash covers the previous entry's hash, so tampering with
// history breaks the chain verifiably.
package receipts

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"time"
)

type Entry struct {
	Time         string `json:"time"`
	Actor        string `json:"actor"`
	TokenJTI     string `json:"token_jti"`
	Scope        string `json:"scope"`
	Page         string `json:"page"`
	Result       string `json:"result"` // applied | proposed | accepted | rejected
	Reason       string `json:"reason,omitempty"`
	RevID        string `json:"rev_id,omitempty"`
	BeforeVer    int64  `json:"before_version"`
	AfterVer     int64  `json:"after_version"`
	ProposalID   string `json:"proposal_id,omitempty"`
	RequestID    string `json:"request_id,omitempty"`
	PrevHash     string `json:"prev_hash"`
	Hash         string `json:"hash"`
}

type Log struct {
	mu   sync.Mutex
	path string
	last string
}

func hashEntry(e Entry) string {
	e.Hash = ""
	b, _ := json.Marshal(e)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// tailHash returns the hash of the log's current last entry ("" if none).
func tailHash(path string) (string, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDONLY, 0o644)
	if err != nil {
		return "", err
	}
	defer f.Close()
	last := ""
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		var e Entry
		if err := json.Unmarshal(sc.Bytes(), &e); err == nil && e.Hash != "" {
			last = e.Hash
		}
	}
	return last, sc.Err()
}

// Open opens (or creates) the receipt log and finds the chain head.
func Open(path string) (*Log, error) {
	last, err := tailHash(path)
	if err != nil {
		return nil, err
	}
	return &Log{path: path, last: last}, nil
}

// Append writes one entry to the chain. The chain head is re-read from
// disk on every append: the server and the CLI (e.g. `accept`) are
// separate processes appending to the same log, and a cached head goes
// stale the moment the other process writes. Appends are sequential in
// practice on a single host; the re-read keeps the chain correct under
// that interleaving.
func (l *Log) Append(e Entry) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	head, err := tailHash(l.path)
	if err != nil {
		return err
	}
	l.last = head
	e.Time = time.Now().UTC().Format(time.RFC3339)
	e.PrevHash = l.last
	e.Hash = hashEntry(e)
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(append(b, '\n')); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	l.last = e.Hash
	return nil
}

// Verify walks the whole log and checks the hash chain.
func Verify(path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	prev := ""
	n := 0
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		var e Entry
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			return n, errors.New("corrupt receipt line")
		}
		if e.PrevHash != prev {
			return n, errors.New("receipt chain broken: prev_hash mismatch")
		}
		if hashEntry(e) != e.Hash {
			return n, errors.New("receipt chain broken: hash mismatch")
		}
		prev = e.Hash
		n++
	}
	return n, sc.Err()
}
