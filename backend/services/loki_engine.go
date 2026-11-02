package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// LokiEngine searches Grafana Loki via its HTTP API.
//
// Query mapping (kept deliberately simple and predictable):
//   - a query starting with "{" (or containing " |"/"|~"/"|=") is used as
//     LogQL as-is — power users write real LogQL
//   - anything else becomes a case-insensitive line filter on top of the
//     configured stream selector:  {job=~".+"} |~ "(?i)<quoted text>"
type LokiEngine struct {
	baseURL  string
	tenant   string
	selector string // default stream selector
	http     *http.Client
}

func NewLokiEngine(baseURL, tenant, selector string) *LokiEngine {
	if selector == "" {
		selector = `{service_name=~".+"}`
	}
	return &LokiEngine{
		baseURL:  strings.TrimRight(baseURL, "/"),
		tenant:   strings.TrimSpace(tenant),
		selector: selector,
		http:     &http.Client{Timeout: 30 * time.Second},
	}
}

func (e *LokiEngine) ID() string { return "loki" }

func (e *LokiEngine) logQL(req EngineRequest) string {
	q := strings.TrimSpace(req.Query)
	if q == "" {
		return e.selector
	}
	if isRawLogQL(q) {
		return q
	}
	// Case-insensitive line filter; QuoteMeta makes the text literal regex.
	return e.selector + ` |~ "(?i)` + regexp.QuoteMeta(q) + `"`
}

// isRawLogQL reports whether the query already looks like LogQL.
func isRawLogQL(q string) bool {
	return strings.HasPrefix(q, "{") ||
		strings.Contains(q, " |") ||
		strings.Contains(q, "|~") ||
		strings.Contains(q, "|=")
}

func (e *LokiEngine) Search(ctx context.Context, req EngineRequest) (*EngineResult, error) {
	now := time.Now().UnixMilli()
	end := req.ToMS
	if end == 0 {
		end = now
	}
	start := req.FromMS
	if start == 0 {
		start = end - time.Hour.Milliseconds() // default window: last hour
	}
	limit := req.MaxHits
	if limit <= 0 {
		// Count mode (dashboard totals): fetch up to Loki's per-request cap —
		// best-effort total, capped at 5000 lines.
		limit = 5000
	}
	if limit > 5000 {
		limit = 5000
	}

	path := "/loki/api/v1/query_range"
	if e.tenant != "" {
		path = "/loki/api/v1/tenant/" + url.PathEscape(e.tenant) + "/query_range"
	}
	vals := url.Values{}
	vals.Set("query", e.logQL(req))
	vals.Set("start", strconv.FormatInt(start*1_000_000, 10)) // ms → ns
	vals.Set("end", strconv.FormatInt(end*1_000_000, 10))
	vals.Set("limit", strconv.Itoa(limit))
	vals.Set("direction", "backward") // newest first, like the other engines

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, e.baseURL+path+"?"+vals.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("build loki request: %w", err)
	}
	resp, err := e.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("cannot reach Loki (%s): %w", e.baseURL, err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Loki API error %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	var parsed struct {
		Data struct {
			Result []struct {
				Stream map[string]string `json:"stream"`
				Values [][]string        `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decode Loki response: %w", err)
	}

	hits := make([]map[string]interface{}, 0, limit)
	for _, r := range parsed.Data.Result {
		for _, v := range r.Values {
			if len(v) < 2 {
				continue
			}
			tsNS, _ := strconv.ParseInt(v[0], 10, 64)
			hits = append(hits, normHit(
				tsNS/1_000_000,
				"",
				v[1],
				labelAny(r.Stream, "ip", "source_ip"),
				labelAny(r.Stream, "host", "pod", "instance"),
				labelAny(r.Stream, "job", "service_name", "app"),
				"loki",
			))
			if len(hits) >= limit {
				return &EngineResult{Hits: hits, Total: uint64(len(hits))}, nil
			}
		}
	}
	return &EngineResult{Hits: hits, Total: uint64(len(hits))}, nil
}

// labelAny returns the first matching stream label.
func labelAny(labels map[string]string, names ...string) string {
	for _, n := range names {
		if v := labels[n]; v != "" {
			return v
		}
	}
	return ""
}
