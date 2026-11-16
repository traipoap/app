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

// resumeWhere scopes every CV query to the owning account.
const resumeWhere = "user_id = ?"

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
		err := db.Where(resumeWhere, id).First(&resume).Error
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

// bindResumePayload returns the trimmed JSON object from the request
// envelope, or an error describing the bad input — respond with 400.
func bindResumePayload(c *gin.Context) (string, error) {
	var input resumeInput
	if err := c.ShouldBindJSON(&input); err != nil {
		return "", errors.New("Field 'data' is required")
	}
	payload := bytes.TrimSpace(input.Data)
	if len(payload) == 0 || payload[0] != '{' {
		return "", errors.New("'data' must be a JSON object")
	}
	return string(payload), nil
}

// upsertResume stores the CV document for the account, creating the
// row on first save.
func upsertResume(db *gorm.DB, id uint, doc string) error {
	var resume models.Resume
	err := db.Where(resumeWhere, id).First(&resume).Error
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		return db.Create(&models.Resume{UserID: id, Data: doc}).Error
	case err != nil:
		return err
	}
	resume.Data = doc
	return db.Save(&resume).Error
}

// HandleResumePut upserts the CV document for the authenticated account.
func HandleResumePut(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := actorUserID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			return
		}

		doc, err := bindResumePayload(c)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		if err := upsertResume(db, id, doc); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save resume"})
			return
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

		res := db.Where(resumeWhere, id).Delete(&models.Resume{})
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
