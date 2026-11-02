package models

import "time"

// RevokedToken tracks refresh tokens that must no longer be accepted —
// either rotated away by single-use refresh or explicitly logged out.
// Rows are safe to prune once the token's own expiry has passed.
type RevokedToken struct {
	ID        uint      `gorm:"primaryKey"`
	JTI       string    `gorm:"uniqueIndex;not null;size:36"`
	ExpiresAt time.Time `gorm:"index"`
}
