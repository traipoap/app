package models

type SearchParams struct {
	IndexID           *string `form:"index_id"`
	FromTimestamp     *string `form:"from_timestamp"`
	ToTimestamp       *string `form:"to_timestamp"`
	SourceIP          *string `form:"source_ip"`
	Message           *string `form:"message"`
	RawQuery          *string `form:"raw_query"`
	Tenant            *string `form:"tenant"`
	MaxHits           *int    `form:"max_hits"`
	EndIndexTimestamp *string `form:"index_timestamp"`
}

type SearchResponse struct {
	Hits  []map[string]interface{} `json:"hits"`
	Total uint64                   `json:"total"`
}

// Quickwit API request (internal use)
type QuickwitSearchRequest struct {
	Query   string `json:"query"`
	MaxHits int    `json:"max_hits"`
	SortBy  string `json:"sort_by,omitempty"` // Quickwit expects a single field name for fast-field sort
}
