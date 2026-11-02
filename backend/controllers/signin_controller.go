package controllers

import (
	"exporter/models"
	"exporter/services"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// targetBCryptCost is the cost we want for new password hashes.
// Cost 10 ≈ 10ms per verify on modern hardware — fast enough for login,
// still secure against brute-force for short passwords.
const targetBCryptCost = 10

// Auth handlers
func HandleSignIn(db *gorm.DB, jwtService *services.JWTService) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 1. Extract Basic Auth credentials
		username, password, hasAuth := c.Request.BasicAuth()
		if !hasAuth || username == "" || password == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Missing or invalid credentials"})
			return
		}

		// 2. Retrieve user from SQLite database
		var user models.User
		if err := db.Where("username = ?", username).First(&user).Error; err != nil {
			if err == gorm.ErrRecordNotFound {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid credentials"})
			} else {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
			}
			return
		}

		// 3. Verify password using bcrypt
		if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid credentials"})
			return
		}

		// 3a. Lazy rehash: if the stored hash uses a different bcrypt cost than
		//     our target, upgrade it in the background (fire-and-forget). This
		//     lets users who registered with cost-14 hashes transparently
		//     migrate to cost-10 without needing to reset their password.
		if cost := bcryptCost(user.PasswordHash); cost != targetBCryptCost {
			if newHash, err := bcrypt.GenerateFromPassword([]byte(password), targetBCryptCost); err == nil {
				db.Model(&user).Update("password_hash", string(newHash)) // best-effort
			}
		}

		// 4. Generate JWT tokens
		userID := fmt.Sprintf("%d", user.ID)

		accessToken, err := jwtService.GenerateToken(userID, user.Username, user.Role)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate access token"})
			return
		}

		refreshToken, err := jwtService.GenerateRefreshToken(userID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate refresh token"})
			return
		}

		// 5. Return tokens to client
		c.JSON(http.StatusOK, gin.H{
			"token":         accessToken,
			"refresh_token": refreshToken,
		})
	}
}

// bcryptCost extracts the cost factor from a bcrypt hash ("$2a$14$...").
// Returns -1 if the hash is malformed.
func bcryptCost(hash string) int {
	parts := strings.Split(hash, "$")
	if len(parts) < 3 {
		return -1
	}
	cost, err := strconv.Atoi(parts[2])
	if err != nil {
		return -1
	}
	return cost
}

type refreshRequest struct {
	RefreshToken string `json:"refresh_token" binding:"required"`
}

// HandleRefresh validates a refresh token and issues new access + refresh tokens.
//
// Refresh tokens are single-use: the presented token is recorded as revoked
// BEFORE its replacement is issued, so a stolen, stale or replayed copy can
// never be exchanged again — and logout (which revokes the same way) is
// authoritative.
func HandleRefresh(db *gorm.DB, jwtService *services.JWTService) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req refreshRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Missing refresh_token"})
			return
		}

		// 1. Validate the refresh token (signing method, signature, expiry)
		claims, err := jwtService.ParseRefreshToken(req.RefreshToken)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid or expired refresh token"})
			return
		}
		userID := claims.Subject

		// 2. Reject tokens already revoked (rotated away or logged out)
		var revoked int64
		if err := db.Model(&models.RevokedToken{}).Where("jti = ?", claims.ID).Count(&revoked).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
			return
		}
		if revoked > 0 {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Refresh token already used"})
			return
		}

		// 3. Look up user by ID
		var user models.User
		idUint, _ := strconv.ParseUint(userID, 10, 64)
		if err := db.First(&user, idUint).Error; err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "User not found"})
			return
		}

		// 4. Revoke the presented token (single-use rotation), then prune
		//    revocation rows whose tokens have already expired.
		expiry := time.Now()
		if claims.ExpiresAt != nil {
			expiry = claims.ExpiresAt.Time
		}
		if err := db.Create(&models.RevokedToken{JTI: claims.ID, ExpiresAt: expiry}).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to record token revocation"})
			return
		}
		db.Where("expires_at < ?", time.Now()).Delete(&models.RevokedToken{}) // best-effort

		// 5. Issue the replacement tokens
		accessToken, err := jwtService.GenerateToken(userID, user.Username, user.Role)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate access token"})
			return
		}

		newRefreshToken, err := jwtService.GenerateRefreshToken(userID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate refresh token"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"token":         accessToken,
			"refresh_token": newRefreshToken,
		})
	}
}
