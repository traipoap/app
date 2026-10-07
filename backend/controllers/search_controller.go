package controllers

import (
	"fmt"
	"io"
	"net/http"
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

// buildLuceneQuery constructs Lucene-style query from params.
// If a user-supplied raw query (raw_query) is present it takes precedence
// over the message/source_ip filters; the timestamp range is still applied
// on top of it so time-window semantics stay consistent.
func buildLuceneQuery(p models.SearchParams) string {
	if p.RawQuery != nil && strings.TrimSpace(*p.RawQuery) != "" {
		var parts []string
		if p.FromTimestamp != nil && p.ToTimestamp != nil {
			parts = append(parts, fmt.Sprintf("timestamp:[%s TO %s]",
				*p.FromTimestamp, *p.ToTimestamp))
		}
		parts = append(parts, *p.RawQuery)
		return strings.Join(parts, " AND ")
	}

	var parts []string

	// ✅ Timestamp range
	if p.FromTimestamp != nil && p.ToTimestamp != nil {
		parts = append(parts, fmt.Sprintf("timestamp:[%s TO %s]",
			*p.FromTimestamp, *p.ToTimestamp))
	}

	// ✅ Source IP with escaping
	if p.SourceIP != nil {
		parts = append(parts, fmt.Sprintf("source_ip:%s", escapeLucene(*p.SourceIP)))
	}

	// ✅ Custom filter with escaping
	if p.Message != nil {
		parts = append(parts, fmt.Sprintf("message:%s", escapeLucene(*p.Message)))
	}

	// ✅ Index timestamp (fix: ใช้ %s สำหรับ *string)
	if p.EndIndexTimestamp == nil {
		parts = append(parts, "index_timestamp:[* TO *]")
	} else {
		parts = append(parts, fmt.Sprintf("index_timestamp:[* TO %s]", *p.EndIndexTimestamp))
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
