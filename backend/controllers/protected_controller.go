package controllers

import (
	"net/http"
	"time"

	"exporter/models"
	"exporter/services"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func HandleProfile(c *gin.Context) {
	userID, _ := c.Get("userID")
	c.JSON(http.StatusOK, gin.H{"user_id": userID})
}

func HandleAdmin(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"message": "Admin access granted"})
}

type logoutRequest struct {
	RefreshToken string `json:"refresh_token"`
}

// HandleLogout revokes the presented refresh token server-side, so no
// surviving copy (other tabs, stale clients, leaks) can be exchanged for
// new access tokens. The client wipes its own storage as well; this is the
// authoritative invalidation.
func HandleLogout(db *gorm.DB, jwtService *services.JWTService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req logoutRequest
		_ = c.ShouldBindJSON(&req) // body optional — logout must never hard-fail

		if req.RefreshToken != "" {
			if claims, err := jwtService.ParseRefreshToken(req.RefreshToken); err == nil && claims.ID != "" {
				expiry := time.Now()
				if claims.ExpiresAt != nil {
					expiry = claims.ExpiresAt.Time
				}
				// Upsert: an already-revoked token is a no-op, not an error.
				db.Where(models.RevokedToken{JTI: claims.ID}).
					Assign(models.RevokedToken{ExpiresAt: expiry}).
					FirstOrCreate(&models.RevokedToken{})
			}
		}

		// Best-effort cleanup of expired revocation rows.
		db.Where("expires_at < ?", time.Now()).Delete(&models.RevokedToken{})

		c.JSON(http.StatusOK, gin.H{"message": "Logged out successfully"})
	}
}
