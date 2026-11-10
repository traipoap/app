package controllers

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"

	"exporter/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// The publish endpoints move the owner's CV store to a single global
// row that the public /cv page can read without authentication.
// Write access is admin-only (wired in the router); the owner check
// below keeps the row locked to the account that first published it.

// publishedStore is just enough shape to sanity-check a publish
// payload without mirroring the whole frontend document.
type publishedStore struct {
	Versions map[string]json.RawMessage `json:"versions"`
}

func validPublishedPayload(raw json.RawMessage) bool {
	payload := bytes.TrimSpace(raw)
	if len(payload) == 0 || payload[0] != '{' {
		return false
	}
	var store publishedStore
	if err := json.Unmarshal(payload, &store); err != nil {
		return false
	}
	return len(store.Versions) > 0
}

// HandlePublishedGet returns the published CV document. It is public —
// HR visitors have no token — or 404 when nothing has been published.
func HandlePublishedGet(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var pub models.PublishedResume
		if err := db.First(&pub).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "Not published yet"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load published resume"})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"data":      json.RawMessage(pub.Data),
			"updatedAt": pub.UpdatedAt,
		})
	}
}

// HandlePublishedPut stores the given document as the published CV,
// creating the row on first use. Only the publishing account can
// update it afterwards.
func HandlePublishedPut(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := actorUserID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			return
		}

		var input resumeInput
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Field 'data' is required"})
			return
		}
		if !validPublishedPayload(input.Data) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "'data' must be a CV store with at least one version"})
			return
		}
		doc := string(bytes.TrimSpace(input.Data))

		var pub models.PublishedResume
		err := db.First(&pub).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			pub = models.PublishedResume{OwnerID: id, Data: doc}
			if createErr := db.Create(&pub).Error; createErr != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish resume"})
				return
			}
		case err != nil:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish resume"})
			return
		default:
			if pub.OwnerID != id {
				c.JSON(http.StatusForbidden, gin.H{"error": "Only the publishing account can update the published resume"})
				return
			}
			pub.Data = doc
			if saveErr := db.Save(&pub).Error; saveErr != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish resume"})
				return
			}
		}

		c.JSON(http.StatusOK, gin.H{"message": "Published"})
	}
}

// HandlePublishedDelete removes the published document so the /cv page
// falls back to its bundled sample data.
func HandlePublishedDelete(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := actorUserID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			return
		}

		var pub models.PublishedResume
		if err := db.First(&pub).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "Not published yet"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load published resume"})
			return
		}
		if pub.OwnerID != id {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only the publishing account can unpublish"})
			return
		}
		if err := db.Delete(&pub).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unpublish resume"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"message": "Unpublished"})
	}
}
