package models

import "time"

// PublishedResume stores the owner's public CV document — the one
// rendered at the /cv page — as an opaque JSON blob. It is a single
// global row; OwnerID records who published it so only that account
// can update or remove it.
type PublishedResume struct {
	ID        uint   `gorm:"primaryKey"`
	OwnerID   uint   `gorm:"not null;index"`
	Data      string `gorm:"type:text;not null"`
	UpdatedAt time.Time
}
