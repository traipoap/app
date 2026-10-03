package controllers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

var (
	exportsDir       = filepath.Join(os.Getenv("BASE_PATH"), "exports")
	hashRegistryName = ".hash_registry.jsonl"
)

type exportFile struct {
	Name    string `json:"name"`
	ModTime string `json:"time"`
	Size    uint64 `json:"size"`
	Hash    string `json:"hash"`
}

func hashRegistryPath() string {
	return filepath.Join(exportsDir, hashRegistryName)
}

// readHashRegistry loads all valid records, in file order (last entry for a
// given file wins when callers build a name→record map).
func readHashRegistry() ([]HashRecord, error) {
	var records []HashRecord
	f, err := os.Open(hashRegistryPath())
	if os.IsNotExist(err) {
		return nil, nil // no registry yet — not an error
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var rec HashRecord
		if json.Unmarshal([]byte(line), &rec) != nil || rec.Hash == "" || rec.Source == "" {
			continue // skip malformed lines
		}
		records = append(records, rec)
	}
	return records, scanner.Err()
}

// rewriteHashRegistry atomically rewrites the registry (tmp file + rename).
func rewriteHashRegistry(records []HashRecord) error {
	tmp := hashRegistryPath() + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(f) // Encode appends '\n' → JSONL
	for i := range records {
		if err := enc.Encode(&records[i]); err != nil {
			f.Close()
			_ = os.Remove(tmp)
			return err
		}
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, hashRegistryPath())
}

// HandleExportsList returns metadata for every export file (sorted newest-first).
// Hashes come from .hash_registry.jsonl (computed once at export time) instead
// of re-hashing every file on each request — that was the slow part. Files with
// no registry entry (e.g. created before the registry existed) show "unknown".
func HandleExportsList(c *gin.Context) {
	records, _ := readHashRegistry()
	latest := make(map[string]HashRecord, len(records))
	for _, r := range records {
		latest[filepath.Base(r.Source)] = r
	}

	files, err := os.ReadDir(exportsDir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list exports"})
		return
	}

	var result []exportFile
	for _, f := range files {
		if f.IsDir() || f.Name() == hashRegistryName {
			continue
		}
		name := f.Name()
		if !(strings.HasSuffix(name, ".csv") || strings.HasSuffix(name, ".csv.gz")) {
			continue
		}

		info, err := f.Info()
		if err != nil {
			continue
		}

		hash := "unknown"
		if rec, ok := latest[name]; ok {
			hash = rec.Hash
		}

		result = append(result, exportFile{
			Name:    name,
			ModTime: info.ModTime().Format(time.RFC3339),
			Size:    uint64(info.Size()),
			Hash:    hash,
		})
	}

	// Sort newest first
	sort.Slice(result, func(i, j int) bool {
		return result[i].ModTime > result[j].ModTime
	})

	if result == nil {
		result = []exportFile{}
	}

	c.JSON(http.StatusOK, gin.H{"exports": result})
}

// HandleDeleteExport removes a single exported file and its registry entries.
func HandleDeleteExport(c *gin.Context) {
	filename := c.Param("filename")
	if filename == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "filename is required"})
		return
	}

	cleanName := filepath.Base(filename)
	if cleanName == "" || cleanName == "." || cleanName == ".." {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid filename"})
		return
	}

	filePath := filepath.Join(exportsDir, cleanName)
	_, statErr := os.Stat(filePath)

	// Collect registry entries, dropping every record that points at this file.
	records, _ := readHashRegistry()
	inRegistry := false
	remaining := make([]HashRecord, 0, len(records))
	for _, r := range records {
		if filepath.Base(r.Source) == cleanName {
			inRegistry = true
			continue
		}
		remaining = append(remaining, r)
	}

	if os.IsNotExist(statErr) && !inRegistry {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	if statErr == nil {
		if err := os.Remove(filePath); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete file"})
			return
		}
	}

	if inRegistry {
		if err := rewriteHashRegistry(remaining); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update hash registry"})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"message": fmt.Sprintf("deleted %s", cleanName)})
}
