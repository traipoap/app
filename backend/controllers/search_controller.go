package controllers

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"exporter/config"
	"exporter/models"
	"exporter/services"

	"github.com/gin-gonic/gin"
)

var quickwitClient *services.QuickwitClient

func InitSearchController() error {
	if err := config.Load(); err != nil {
		return err
	}
	quickwitClient = services.NewQuickwitClient(config.AppConfig.QuickwitURL)
	return nil
}

func HandleIndices(c *gin.Context) {
	// Reuse the shared keep-alive client instead of allocating a new
	// http.Client (and a new TLS handshake) per request.
	resp, err := quickwitClient.Get(c.Request.Context(), "/api/v1/indexes")
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Cannot connect to Quickwit: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	// อ่านข้อมูลดิบ (Raw Body) ที่ส่งกลับมาจาก Quickwit
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read Quickwit response: " + err.Error()})
		return
	}

	// ตรวจสอบสถานะการตอบกลับจาก Quickwit
	if resp.StatusCode != http.StatusOK {
		c.Data(resp.StatusCode, "application/json", bodyBytes)
		return
	}

	// Pass Quickwit's JSON through as-is. Decoding it into []interface{}
	// and re-encoding it bought nothing — only CPU time and GC churn.
	c.Data(http.StatusOK, "application/json; charset=utf-8", bodyBytes)
}

func HandleSearch(c *gin.Context) {
	var params models.SearchParams
	if err := c.ShouldBindQuery(&params); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid query parameters: " + err.Error()})
		return
	}

	// SearchRaw keeps Quickwit's `hits` array as raw JSON, so no log field
	// is ever boxed into interface{} or re-encoded through reflection.
	hits, total, err := quickwitClient.SearchRaw(c.Request.Context(), buildLuceneQuery(params), params.MaxHits, params.IndexID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Search failed: " + err.Error()})
		return
	}

	// Splice the raw hits straight into the response body:
	// {"hits":<raw array>,"total":<n>}
	buf := make([]byte, 0, len(hits)+64)
	buf = append(buf, `{"hits":`...)
	buf = append(buf, hits...)
	buf = append(buf, `,"total":`...)
	buf = strconv.AppendUint(buf, total, 10)
	buf = append(buf, '}')
	c.Data(http.StatusOK, "application/json; charset=utf-8", buf)
}

// luceneReplacer escapes Lucene special characters in a single pass.
// (The old per-character strings.ReplaceAll loop copied the string ~18 times.)
var luceneReplacer = strings.NewReplacer(
	`\`, `\\`,
	`+`, `\+`, `-`, `\-`, `!`, `\!`, `(`, `\(`, `)`, `\)`,
	`:`, `\:`, `^`, `\^`, `"`, `\"`,
	`{`, `\{`, `}`, `\}`, `[`, `\[`, `]`, `\]`,
	`~`, `\~`, `*`, `\*`, `?`, `\?`, `|`, `\|`, `&`, `\&`, `/`, `\/`,
)

// tenantField returns the Quickwit field used to pin rows to a tenant.
// Overridable via env TENANT_FIELD (default "tenant_id").
func tenantField() string {
	if f := os.Getenv("TENANT_FIELD"); f != "" {
		return f
	}
	return "tenant_id"
}

// tenantClause builds the tenant pin for the Lucene query, or "" when the
// request is not tenant-scoped (global workspace).
func tenantClause(p models.SearchParams) string {
	if p.Tenant == nil || strings.TrimSpace(*p.Tenant) == "" {
		return ""
	}
	return fmt.Sprintf(`%s:"%s"`, tenantField(), escapeLucene(*p.Tenant))
}

// indexFields holds the per-index Quickwit field mapping. The OTel exporter
// indexes use different field names and time units than `syslogs`, so a
// single static query shape cannot serve all of them.
type indexFields struct {
	messageField string // field matched by the `message` filter param
	sourceField  string // field matched by the `source_ip` filter param
	timeField    string // field used for the time-range clause
	timeUnit     int64  // multiplier from ms (API units) to this field's units
	cursorField  string // integer ns field used for export cursor pagination
}

// fieldsForIndex returns the field mapping for an index family. Verified
// against the live Quickwit cluster (field lists + search probes).
func fieldsForIndex(indexID string) indexFields {
	switch {
	case strings.HasPrefix(indexID, "otel-traces"):
		return indexFields{"span_name", "service_name", "span_start_timestamp_nanos", 1_000_000, "span_start_timestamp_nanos"}
	case strings.HasPrefix(indexID, "otel-logs"):
		return indexFields{"body.message", "service_name", "timestamp_nanos", 1_000_000, "timestamp_nanos"}
	default: // syslogs
		return indexFields{"message", "source_ip", "timestamp", 1, "index_timestamp"}
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// parseMS parses a millisecond epoch value from a query param.
func parseMS(s *string) (int64, bool) {
	if s == nil {
		return 0, false
	}
	v, err := strconv.ParseInt(strings.TrimSpace(*s), 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// timeClause builds the time-range clause in the target index's time field
// and units, or "" when either bound is missing/invalid.
func timeClause(p models.SearchParams, f indexFields) string {
	from, okFrom := parseMS(p.FromTimestamp)
	to, okTo := parseMS(p.ToTimestamp)
	if !okFrom || !okTo {
		return ""
	}
	return fmt.Sprintf("%s:[%d TO %d]", f.timeField, from*f.timeUnit, to*f.timeUnit)
}

// buildLuceneQuery constructs Lucene-style query from params.
//
// Tenant scoping: when `tenant` is provided, a tenant pin
// (tenant_id:"<slug>") is AND-ed into EVERY branch, so search AND export
// (both call this) can never leak another tenant's rows.
//
// A user-supplied raw query (raw_query) takes precedence over the
// message/source_ip filters; the timestamp range is still applied on top
// of it so time-window semantics stay consistent.
func buildLuceneQuery(p models.SearchParams) string {
	f := fieldsForIndex(deref(p.IndexID))
	var parts []string

	if clause := tenantClause(p); clause != "" {
		parts = append(parts, clause)
	}

	if p.RawQuery != nil && strings.TrimSpace(*p.RawQuery) != "" {
		if tsClause := timeClause(p, f); tsClause != "" {
			parts = append(parts, tsClause)
		}
		parts = append(parts, *p.RawQuery)
		return strings.Join(parts, " AND ")
	}

	// ✅ Timestamp range (field+units depend on the index family)
	if tsClause := timeClause(p, f); tsClause != "" {
		parts = append(parts, tsClause)
	}

	// ✅ Source filter with escaping
	if p.SourceIP != nil && *p.SourceIP != "" {
		parts = append(parts, fmt.Sprintf("%s:%s", f.sourceField, escapeLucene(*p.SourceIP)))
	}

	// ✅ Custom filter with escaping
	if p.Message != nil && *p.Message != "" {
		parts = append(parts, fmt.Sprintf("%s:%s", f.messageField, escapeLucene(*p.Message)))
	}

	// ✅ Export pagination cursor (bound set by runExport as last-bound-1,
	// making the inclusive range exclusive).
	if p.EndIndexTimestamp != nil && *p.EndIndexTimestamp != "" {
		parts = append(parts, fmt.Sprintf("%s:[* TO %s]", f.cursorField, *p.EndIndexTimestamp))
	}

	if len(parts) == 0 {
		return "*"
	}

	return strings.Join(parts, " AND ")
}

// escapeLucene escapes special characters in Lucene query syntax
// Reference: https://lucene.apache.org/core/2_9_4/queryparsersyntax.html#Escaping%20Special%20Characters
func escapeLucene(s string) string {
	return luceneReplacer.Replace(s)
}
