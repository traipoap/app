package models

import "time"

// Resume stores the per-account CV builder document as a JSON blob.
// The backend treats it as an opaque payload — the shape belongs to
// the frontend, so no Go struct mirroring is needed.
type Resume struct {
	ID        uint   `gorm:"primaryKey"`
	UserID    uint   `gorm:"uniqueIndex;not null"`
	Data      string `gorm:"type:text;not null"`
	UpdatedAt time.Time
}
