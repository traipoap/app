package services

import (
	"context"
	"strings"
)

// Engine is a pluggable log-search backend (Quickwit, Loki, Elasticsearch).
// Each engine translates the UI's query into its native syntax and returns
// hits normalized into the canonical shape the frontend mapper already
// understands:
//
//	{timestamp: <ms>, level, message, source_ip, host, service, index}
type Engine interface {
	ID() string
	Search(ctx context.Context, req EngineRequest) (*EngineResult, error)
}

// EngineRequest is the engine-agnostic search request built from the API
// params. FromMS/ToMS are 0 when the client did not set a bound.
type EngineRequest struct {
	Query   string // free-text / raw query from the search box
	Source  string // optional index name / stream selector (engine-specific)
	MaxHits int
	FromMS  int64
	ToMS    int64
}

// EngineResult is a normalized search result.
type EngineResult struct {
	Hits  []map[string]interface{}
	Total uint64
}

// normHit builds one canonical hit. Empty optional fields are omitted so the
// JSON stays lean.
func normHit(tsMS int64, level, message, source, host, service, index string) map[string]interface{} {
	h := map[string]interface{}{
		"timestamp": tsMS,
		"message":   message,
		"index":     index,
	}
	if level != "" {
		h["level"] = level
	}
	if source != "" {
		h["source_ip"] = source
	}
	if host != "" {
		h["host"] = host
	}
	if service != "" {
		h["service"] = service
	}
	return h
}

// firstString returns the first non-empty string among the given values.
func firstString(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// truncate caps s for use in error messages.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
