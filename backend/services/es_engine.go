package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ElasticsearchEngine searches Elasticsearch (7.x / 8.x) via the _search API.
//
// Query mapping: the UI query becomes a `query_string` (Lucene syntax —
// the same family as the Quickwit/Lucene queries users already write).
// The time window is applied as a range filter on the configured time
// field (default @timestamp).
type ElasticsearchEngine struct {
	baseURL   string
	username  string
	password  string
	timeField string
	http      *http.Client
}

func NewElasticsearchEngine(baseURL, username, password, timeField string) *ElasticsearchEngine {
	if timeField == "" {
		timeField = "@timestamp"
	}
	return &ElasticsearchEngine{
		baseURL:   strings.TrimRight(baseURL, "/"),
		username:  username,
		password:  password,
		timeField: timeField,
		http:      &http.Client{Timeout: 30 * time.Second},
	}
}

func (e *ElasticsearchEngine) ID() string { return "elasticsearch" }

// readAPIBody reads a (capped) response body and turns non-2xx
// responses into an error, shared by every engine.
func readAPIBody(resp *http.Response, limit int64, name string) ([]byte, error) {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, limit))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s API error %d: %s", name, resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}

// ListIndices returns data index names (internal "." indices excluded) for
// the frontend index dropdown.
func (e *ElasticsearchEngine) ListIndices(ctx context.Context) ([]string, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet,
		e.baseURL+"/_cat/indices?format=json&h=index", nil)
	if err != nil {
		return nil, err
	}
	if e.username != "" {
		httpReq.SetBasicAuth(e.username, e.password)
	}
	resp, err := e.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("cannot reach Elasticsearch (%s): %w", e.baseURL, err)
	}
	defer resp.Body.Close()

	body, err := readAPIBody(resp, 8<<20, "Elasticsearch")
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Index string `json:"index"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, fmt.Errorf("decode ES index list: %w", err)
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		if r.Index == "" || strings.HasPrefix(r.Index, ".") {
			continue
		}
		out = append(out, r.Index)
	}
	return out, nil
}

// esSearchParams are the concrete values for one _search call.
type esSearchParams struct {
	index  string
	size   int
	fromMS int64
	toMS   int64
}

// esHit is one hit of an ES _search response.
type esHit struct {
	Source json.RawMessage `json:"_source"`
}

// searchParams normalizes the request into concrete search parameters.
func (e *ElasticsearchEngine) searchParams(req EngineRequest) esSearchParams {
	index := strings.TrimSpace(req.Source)
	if index == "" {
		index = "*"
	}
	size := req.MaxHits
	if size < 0 {
		size = 100
	}
	// size == 0 is valid: ES count mode returns an exact total without hits.
	if size > 10000 {
		size = 10000
	}
	now := time.Now().UnixMilli()
	to := req.ToMS
	if to == 0 {
		to = now
	}
	from := req.FromMS
	if from == 0 {
		from = to - time.Hour.Milliseconds()
	}
	return esSearchParams{index: index, size: size, fromMS: from, toMS: to}
}

// buildBody assembles the _search body — query_string plus an optional
// time-range filter and newest-first sort.
func (e *ElasticsearchEngine) buildBody(p esSearchParams, query string, withTime bool) []byte {
	must := []interface{}{}
	if query != "" {
		must = append(must, map[string]interface{}{"query_string": map[string]interface{}{"query": query}})
	} else {
		must = append(must, map[string]interface{}{"match_all": map[string]interface{}{}})
	}
	boolQ := map[string]interface{}{"must": must}
	if withTime {
		boolQ["filter"] = []interface{}{
			map[string]interface{}{"range": map[string]interface{}{
				e.timeField: map[string]interface{}{"gte": p.fromMS, "lte": p.toMS},
			}},
		}
	}
	body := map[string]interface{}{"size": p.size, "query": map[string]interface{}{"bool": boolQ}}
	if withTime {
		body["sort"] = []interface{}{map[string]interface{}{e.timeField: map[string]interface{}{"order": "desc"}}}
	}
	raw, _ := json.Marshal(body)
	return raw
}

// searchOnce performs a single _search request.
func (e *ElasticsearchEngine) searchOnce(ctx context.Context, index string, body []byte) (*http.Response, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		e.baseURL+"/"+index+"/_search", bytes.NewReader(body)) // index names are [a-z0-9_-]; * is valid
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if e.username != "" {
		httpReq.SetBasicAuth(e.username, e.password)
	}
	return e.http.Do(httpReq)
}

func (e *ElasticsearchEngine) Search(ctx context.Context, req EngineRequest) (*EngineResult, error) {
	p := e.searchParams(req)
	query := strings.TrimSpace(req.Query)

	resp, err := e.searchOnce(ctx, p.index, e.buildBody(p, query, true))
	if err != nil {
		return nil, fmt.Errorf("cannot reach Elasticsearch (%s): %w", e.baseURL, err)
	}
	defer resp.Body.Close()

	// The configured time field may not exist on every index (400) — retry
	// once without the range filter / sort so a plain full-text search works.
	if resp.StatusCode == http.StatusBadRequest {
		resp.Body.Close()
		resp, err = e.searchOnce(ctx, p.index, e.buildBody(p, query, false))
		if err != nil {
			return nil, fmt.Errorf("cannot reach Elasticsearch (%s): %w", e.baseURL, err)
		}
		defer resp.Body.Close()
	}

	body, err := readAPIBody(resp, 64<<20, "Elasticsearch")
	if err != nil {
		return nil, err
	}

	var parsed struct {
		Hits struct {
			Total interface{} `json:"total"` // number (ES<7) or {value: n} (ES7+)
			Hits  []esHit     `json:"hits"`
		} `json:"hits"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decode Elasticsearch response: %w", err)
	}

	return &EngineResult{Hits: e.normalizeHits(parsed.Hits.Hits, p.index), Total: totalValue(parsed.Hits.Total)}, nil
}

// normalizeHits maps parsed _source documents onto the canonical hit shape.
func (e *ElasticsearchEngine) normalizeHits(raw []esHit, index string) []map[string]interface{} {
	hits := make([]map[string]interface{}, 0, len(raw))
	for _, h := range raw {
		var src map[string]interface{}
		if err := json.Unmarshal(h.Source, &src); err != nil {
			continue
		}
		hits = append(hits, normalizeESSrc(src, e.timeField, index))
	}
	return hits
}

// normalizeESSrc maps an ES _source document onto the canonical hit shape.
func normalizeESSrc(src map[string]interface{}, timeField, index string) map[string]interface{} {
	get := func(keys ...string) interface{} {
		for _, k := range keys {
			if v, ok := src[k]; ok && v != nil {
				return v
			}
		}
		return nil
	}
	str := func(v interface{}) string {
		switch t := v.(type) {
		case string:
			return t
		case float64:
			return strconv.FormatFloat(t, 'f', -1, 64)
		default:
			if v != nil {
				b, _ := json.Marshal(v)
				return string(b)
			}
			return ""
		}
	}

	// timestamp: string (RFC3339) or epoch (s/ms/ns) under several names
	var tsMS int64
	if raw := get(timeField, "@timestamp", "timestamp", "time_unix_nano", "timeUnixNano", "log.time"); raw != nil {
		switch t := raw.(type) {
		case float64:
			f := t
			if f > 1e17 {
				f /= 1e6 // ns → ms
			} else if f > 1e14 {
				f /= 1e3 // µs → ms
			} else if f < 1e11 {
				f *= 1e3 // s → ms
			}
			tsMS = int64(f)
		case string:
			if p, err := time.Parse(time.RFC3339Nano, t); err == nil {
				tsMS = p.UnixMilli()
			}
		}
	}
	if tsMS == 0 {
		tsMS = time.Now().UnixMilli()
	}

	// message: plain string, OTel {message}, or `body`
	message := str(get("message", "msg", "content", "line", "log"))
	if message == "" {
		if body, ok := src["body"].(map[string]interface{}); ok {
			message = str(body["message"])
		}
	}

	host := str(get("host.name", "hostname", "host", "pod.name", "container.name"))
	if h, ok := src["host"].(map[string]interface{}); ok {
		host = firstString(host, str(h["name"]))
	}
	source := str(get("source_ip", "source", "client.ip", "ip"))
	if s, ok := src["client"].(map[string]interface{}); ok {
		source = firstString(source, str(s["ip"]))
	}

	return normHit(
		tsMS,
		str(get("level", "severity", "severityText", "log.level")),
		message,
		source,
		host,
		str(get("service.name", "service_name", "service", "app")),
		index,
	)
}

// totalValue reads hits.total from both legacy (number) and modern ({value})
// response shapes.
func totalValue(v interface{}) uint64 {
	switch t := v.(type) {
	case float64:
		return uint64(t)
	case map[string]interface{}:
		if f, ok := t["value"].(float64); ok {
			return uint64(f)
		}
	}
	return 0
}
