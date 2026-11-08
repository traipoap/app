package controllers

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"exporter/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// resumeInput wraps the CV document so the backend can store the JSON
// blob verbatim without mirroring the frontend shape in Go.
type resumeInput struct {
	Data json.RawMessage `json:"data" binding:"required"`
}

// actorUserID resolves the authenticated account's numeric id.
func actorUserID(c *gin.Context) (uint, bool) {
	raw, ok := c.Get("userID")
	if !ok {
		return 0, false
	}
	idStr, ok := raw.(string)
	if !ok {
		return 0, false
	}
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		return 0, false
	}
	return uint(id), true
}

// HandleResumeGet returns the CV document saved for the authenticated
// account, or 404 when the account has not saved one yet.
func HandleResumeGet(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := actorUserID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			return
		}

		var resume models.Resume
		err := db.Where("user_id = ?", id).First(&resume).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Resume not found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load resume"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"data": json.RawMessage(resume.Data)})
	}
}

// HandleResumePut upserts the CV document for the authenticated account.
func HandleResumePut(db *gorm.DB) gin.HandlerFunc {
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
		payload := bytes.TrimSpace(input.Data)
		if len(payload) == 0 || payload[0] != '{' {
			c.JSON(http.StatusBadRequest, gin.H{"error": "'data' must be a JSON object"})
			return
		}
		doc := string(payload)

		var resume models.Resume
		err := db.Where("user_id = ?", id).First(&resume).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			resume = models.Resume{UserID: id, Data: doc}
			if createErr := db.Create(&resume).Error; createErr != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save resume"})
				return
			}
		case err != nil:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save resume"})
			return
		default:
			resume.Data = doc
			if saveErr := db.Save(&resume).Error; saveErr != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save resume"})
				return
			}
		}

		c.JSON(http.StatusOK, gin.H{"message": "Resume saved"})
	}
}

// HandleResumeDelete removes the CV document saved for the authenticated
// account; 404 when the account has no saved copy.
func HandleResumeDelete(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := actorUserID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			return
		}

		res := db.Where("user_id = ?", id).Delete(&models.Resume{})
		if res.Error != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete resume"})
			return
		}
		if res.RowsAffected == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "Resume not found"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"message": "Resume deleted"})
	}
}
