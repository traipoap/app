package controllers

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync/atomic"
	"time"

	"exporter/config"
	"exporter/models"
	"exporter/services"

	"github.com/gin-gonic/gin"
)

var exportService *services.ExportService
var exportDirPath string

// activeExports enforces at most one concurrent export, mirroring the Rust
// backend's ACTIVE_EXPORTS guard.
var activeExports int32

const (
	exportPageSize  = 10000 // Quickwit's per-request hit cap
	exportPagePause = 100 * time.Millisecond
	exportMaxAge    = 30 * time.Minute // hard cap for a single export job
)

// HashRecord models the JSON Lines hash registry entry (same as Rust's HashRecord).
type HashRecord struct {
	Hash      string `json:"hash"`
	Timestamp string `json:"timestamp"`
	Source    string `json:"source"`
}

func InitExportController() error {
	if err := config.Load(); err != nil {
		return err
	}

	qwClient := services.NewQuickwitClient(config.AppConfig.QuickwitURL)

	exportDirPath = filepath.Join(config.AppConfig.BasePath, "exports")
	if err := os.MkdirAll(exportDirPath, 0755); err != nil {
		return err
	}

	pdpaFields := []string{"source_ip", "user_id", "email", "phone"}

	exportService = services.NewExportService(qwClient, exportDirPath, pdpaFields)
	return nil
}

// HandleExport starts a server-side CSV export and returns 202 immediately,
// mirroring the async Rust handler. The export runs in the background: it
// pages through Quickwit in 10k-hit chunks and streams each row straight to
// a buffered file writer, so memory stays flat no matter how many logs match
// (the previous implementation fetched all hits and built the whole CSV in
// a bytes.Buffer before writing, while blocking the request).
func HandleExport(c *gin.Context) {
	var params models.SearchParams
	if err := c.ShouldBindQuery(&params); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid query parameters: " + err.Error()})
		return
	}

	// index_id is required (Quickwit routes the search by index).
	if params.IndexID == nil || *params.IndexID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "index_id is required"})
		return
	}

	// Rate limit: only one export at a time (like Rust's ACTIVE_EXPORTS)
	if !atomic.CompareAndSwapInt32(&activeExports, 0, 1) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many exports in progress"})
		return
	}

	// The request context is cancelled when this handler returns, so the
	// background job gets its own context with a hard cap.
	ctx, cancel := context.WithTimeout(context.Background(), exportMaxAge)

	go func() {
		defer atomic.StoreInt32(&activeExports, 0)
		defer cancel()
		if err := runExport(ctx, params); err != nil {
			fmt.Printf("export failed: %v\n", err)
		}
	}()

	c.JSON(http.StatusAccepted, gin.H{
		"status":  "processing",
		"message": "Export started. Check the export queue for progress.",
	})
}

// runExport pages through Quickwit and streams CSV rows directly to disk.
func runExport(ctx context.Context, params models.SearchParams) error {
	// Page size: honor the client's max_hits when it is smaller, but never
	// exceed Quickwit's per-request cap.
	pageSize := exportPageSize
	if params.MaxHits != nil && *params.MaxHits > 0 && *params.MaxHits < exportPageSize {
		pageSize = *params.MaxHits
	}

	// runExport — replace the local block with:
	if err := os.MkdirAll(exportDirPath, 0755); err != nil {
		return fmt.Errorf("create exports directory: %w", err)
	}

	base := "any"
	if params.SourceIP != nil && *params.SourceIP != "" {
		base = sanitizeFileName(*params.SourceIP)
	}
	// Bangkok time (UTC+7, no DST) for the filename.
	bangkokLoc, err := time.LoadLocation("Asia/Bangkok")
	if err != nil {
		bangkokLoc = time.FixedZone("ICT", 7*60*60)
	}
	now := time.Now().In(bangkokLoc)
	fileName := fmt.Sprintf("%s_%s.csv", base, now.Format("20060102_150405"))
	filePath := filepath.Join(exportDirPath, fileName)

	file, err := os.Create(filePath)
	if err != nil {
		return fmt.Errorf("create export file: %w", err)
	}
	defer file.Close()

	// One 1MB buffer shared by the CSV writer and the file — rows are
	// flushed in chunks instead of one syscall per row.
	bufw := bufio.NewWriterSize(file, 1<<20)
	wtr := csv.NewWriter(bufw)

	var processed int
	headerWritten := false
	sink := func(hit map[string]json.RawMessage) error {
		if !headerWritten {
			if err := wtr.Write([]string{"message"}); err != nil {
				return fmt.Errorf("write CSV header: %w", err)
			}
			headerWritten = true
		}
		if err := wtr.Write([]string{csvMessage(hit)}); err != nil {
			return fmt.Errorf("write CSV row: %w", err)
		}
		processed++
		return nil
	}

	f := fieldsForIndex(deref(params.IndexID))
	from, okFrom := parseMS(params.FromTimestamp)
	to, okTo := parseMS(params.ToTimestamp)

	err = nil
	if !okFrom || !okTo {
		// No time window supplied — the whole index is capped by Quickwit's
		// 10k start_offset limit (newest ~20k rows).
		fmt.Printf("export: no time window — capped at %d rows (Quickwit start_offset limit)\n", pageSize+quickwitOffsetCap)
		_, err = writeOffsetPages(ctx, buildLuceneQuery(params), params.IndexID, pageSize, sink)
	} else {
		// Windowed export: chunk + bounded offset paging (fully covered,
		// no dups, no skips — see exportWindow).
		_, err = exportWindow(ctx, params, f, params.IndexID, from, to, pageSize, sink)
	}
	if err != nil {
		return fmt.Errorf("export rows: %w", err)
	}

	wtr.Flush()
	if err := wtr.Error(); err != nil {
		return fmt.Errorf("csv writer: %w", err)
	}
	if err := bufw.Flush(); err != nil {
		return fmt.Errorf("flush CSV buffer: %w", err)
	}
	if processed == 0 {
		_ = os.Remove(filePath) // drop the empty file; deferred Close is harmless
	} else if hash, err := computeSHA256(filePath); err == nil {
		// Log hash to registry (mirroring Rust's append_hash_record pattern)
		if err := appendHashRecord(hash, filePath); err != nil {
			fmt.Printf("failed to append hash record: %v\n", err)
		}
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync file: %w", err)
	}

	fmt.Printf("exported %d logs to %s\n", processed, filePath)
	return nil
}

// csvMessage pulls the human-readable message out of a hit. Syslog-style
// indexes store it under `message`; OTel log records carry it as an embedded
// `body.message` object — the old code only read the former, so OTel exports
// produced an empty column for every row.
func csvMessage(hit map[string]json.RawMessage) string {
	if raw, ok := hit["message"]; ok {
		if v := csvCell(raw); v != "" {
			return v
		}
	}
	if raw, ok := hit["body"]; ok && len(raw) > 0 {
		if raw[0] == '{' {
			var obj map[string]json.RawMessage
			if err := json.Unmarshal(raw, &obj); err == nil {
				if m, ok := obj["message"]; ok && len(m) > 0 {
					return csvCell(m)
				}
			}
		}
		return csvCell(raw)
	}
	return ""
}

// quickwitOffsetCap — Quickwit rejects start_offset > 10_000, so offset
// paging can never reach beyond (offset 10_000 + one page) rows per window.
const quickwitOffsetCap = 10000

// minExportWindowMs is the smallest time slice exportWindow recurses to.
// Must be 1 ms (the datetime fields' resolution) — high-density indexes can
// hold >20k rows even in sub-minute slices, so a larger floor would
// silently cap those slices and lose rows.
const minExportWindowMs = 1

// writeOffsetPages streams at most (pageSize + quickwitOffsetCap) rows of
// `query` in oldest-first order — the deep-paging ceiling Quickwit enforces
// (start_offset max 10_000).
func writeOffsetPages(ctx context.Context, query string, indexID *string, pageSize int, sink func(map[string]json.RawMessage) error) (int, error) {
	rows := 0
	maxRows := pageSize + quickwitOffsetCap
	for offset := 0; offset < maxRows; offset += pageSize {
		if err := ctx.Err(); err != nil {
			return rows, err
		}
		page, err := quickwitClient.SearchPage(ctx, query, pageSize, indexID, offset, false)
		if err != nil {
			return rows, fmt.Errorf("search Quickwit: %w", err)
		}
		if len(page.Hits) == 0 {
			break
		}
		for _, hit := range page.Hits {
			if err := sink(hit); err != nil {
				return rows, err
			}
			rows++
		}
		select {
		case <-ctx.Done():
			return rows, fmt.Errorf("export aborted: %w", ctx.Err())
		case <-time.After(exportPagePause):
		}
	}
	return rows, nil
}

// exportWindow fully exports [fromMs, toMs]: it counts the window and, when
// the row count exceeds Quickwit's deep-paging ceiling, splits the window
// in half and recurses on both halves. The slices are disjoint and together
// cover the range exactly, so no row is lost or duplicated — unlike timestamp
// cursors, which are unreliable here because these indexes store event times
// at ms resolution (a bound-1 cursor re-includes the boundary row).
func exportWindow(ctx context.Context, params models.SearchParams, f indexFields, indexID *string, fromMs, toMs int64, pageSize int, sink func(map[string]json.RawMessage) error) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}

	fromStr := strconv.FormatInt(fromMs, 10)
	toStr := strconv.FormatInt(toMs, 10)
	win := params
	win.FromTimestamp = &fromStr
	win.ToTimestamp = &toStr
	query := buildLuceneQuery(win)

	probe, err := quickwitClient.SearchPage(ctx, query, 1, indexID, 0, true)
	if err != nil {
		return 0, fmt.Errorf("search Quickwit: %w", err)
	}
	if probe.NumHits == 0 {
		return 0, nil
	}

	maxRows := pageSize + quickwitOffsetCap
	if probe.NumHits > uint64(maxRows) && toMs-fromMs > minExportWindowMs {
		mid := (fromMs + toMs) / 2
		n1, err := exportWindow(ctx, params, f, indexID, fromMs, mid, pageSize, sink)
		if err != nil {
			return n1, err
		}
		return exportWindow(ctx, params, f, indexID, mid+1, toMs, pageSize, sink)
	}

	if probe.NumHits > uint64(maxRows) {
		fmt.Printf("export: %d rows in the smallest window (> %d); exporting the first %d\n", probe.NumHits, maxRows, maxRows)
	}
	return writeOffsetPages(ctx, query, indexID, pageSize, sink)
}

// csvCell renders a raw JSON value as a CSV cell without boxing it into
// interface{}: strings are unquoted, everything else keeps its raw text.
func csvCell(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			return s
		}
	}
	return string(raw)
}

var unsafeFileNameChars = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// sanitizeFileName keeps only safe filename characters (so an IP like
// 192.168.1.1 stays intact, while spaces/slashes become underscores).
func sanitizeFileName(s string) string {
	return unsafeFileNameChars.ReplaceAllString(s, "_")
}

// Optional: Handler for downloading exported files
func HandleDownload(c *gin.Context) {
	filename := c.Param("filename")

	if filename == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "filename is required"})
		return
	}

	// Prevent path traversal: keep only the base name.
	cleanName := filepath.Base(filename)
	if cleanName == "" || cleanName == "." || cleanName == ".." {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid filename"})
		return
	}

	filePath := filepath.Join("exports", cleanName)

	fileInfo, err := os.Stat(filePath)
	if os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found or expired"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "cannot access file"})
		return
	}
	if fileInfo.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "not a file"})
		return
	}

	c.Header("Content-Description", "File Transfer")
	c.Header("Content-Type", "application/octet-stream")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", cleanName))
	c.Header("Content-Transfer-Encoding", "binary")
	c.Header("Expires", "0")
	c.Header("Cache-Control", "must-revalidate")
	c.Header("Pragma", "public")
	c.Header("Content-Length", fmt.Sprintf("%d", fileInfo.Size()))

	c.File(filePath)
}

// appendHashRecord logs an export file's SHA256 hash to the registry.
// This mirrors Rust's append_hash_record function.
func appendHashRecord(hash, source string) error {
	record := HashRecord{
		Hash:      hash,
		Timestamp: time.Now().Format(time.RFC3339),
		Source:    source,
	}

	jsonLine, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("marshal hash record: %w", err)
	}

	// appendHashRecord — replace the local declaration with:
	registryPath := filepath.Join(exportDirPath, ".hash_registry.jsonl")

	file, err := os.OpenFile(registryPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("open hash registry: %w", err)
	}
	defer file.Close()

	_, err = file.WriteString(string(jsonLine) + "\n")
	return err
}

// computeSHA256 calculates SHA256 hash of a file.
func computeSHA256(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("open file: %w", err)
	}
	defer file.Close()

	hasher := sha256.New()
	_, err = io.Copy(hasher, file)
	if err != nil {
		return "", fmt.Errorf("read file: %w", err)
	}

	return fmt.Sprintf("SHA256:%s", hex.EncodeToString(hasher.Sum(nil))), nil
}
