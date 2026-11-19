package controllers

import (
	"errors"
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

// basicCredentials extracts the Basic Auth pair from the request; ok is
// false when the header is missing or incomplete.
func basicCredentials(c *gin.Context) (username, password string, ok bool) {
	username, password, hasAuth := c.Request.BasicAuth()
	return username, password, hasAuth && username != "" && password != ""
}

// findUser loads the account for the given username.
func findUser(db *gorm.DB, username string) (*models.User, error) {
	var user models.User
	err := db.Where("username = ?", username).First(&user).Error
	if err != nil {
		return nil, err
	}
	return &user, nil
}

// errAuthFail marks bad-credential cases (401) so handlers can tell them
// apart from database failures (500).
var errAuthFail = errors.New("invalid credentials")

// authenticateUser loads the account and checks its password.
func authenticateUser(db *gorm.DB, username, password string) (*models.User, error) {
	user, err := findUser(db, username)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errAuthFail
		}
		return nil, err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, errAuthFail
	}
	return user, nil
}

// upgradeHash rehashes the password at the target bcrypt cost when the
// stored hash uses a different one (best-effort, fire-and-forget). This
// lets accounts registered with cost-14 hashes migrate to cost-10 without
// a password reset.
func upgradeHash(db *gorm.DB, user *models.User, password string) {
	if bcryptCost(user.PasswordHash) == targetBCryptCost {
		return
	}
	if newHash, err := bcrypt.GenerateFromPassword([]byte(password), targetBCryptCost); err == nil {
		db.Model(user).Update("password_hash", string(newHash)) // best-effort
	}
}

// issueTokens mints the access + refresh token pair for a user.
func issueTokens(jwtService *services.JWTService, user *models.User) (string, string, error) {
	userID := fmt.Sprintf("%d", user.ID)
	accessToken, err := jwtService.GenerateToken(userID, user.Username, user.Role)
	if err != nil {
		return "", "", err
	}
	refreshToken, err := jwtService.GenerateRefreshToken(userID)
	if err != nil {
		return "", "", err
	}
	return accessToken, refreshToken, nil
}

// Auth handlers
func HandleSignIn(db *gorm.DB, jwtService *services.JWTService) gin.HandlerFunc {
	return func(c *gin.Context) {
		username, password, ok := basicCredentials(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Missing or invalid credentials"})
			return
		}

		user, err := authenticateUser(db, username, password)
		if errors.Is(err, errAuthFail) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid credentials"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
			return
		}

		// Lazy rehash: migrate older hashes to the target bcrypt cost.
		upgradeHash(db, user, password)

		accessToken, refreshToken, err := issueTokens(jwtService, user)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate tokens"})
			return
		}

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

// errTokenInvalid marks 401 refresh-token cases (bad signature, already
// used, unknown user) so the handler can distinguish them from db errors.
var errTokenInvalid = errors.New("invalid refresh token")

// isRevoked reports whether a refresh token JTI has already been used.
func isRevoked(db *gorm.DB, jti string) (bool, error) {
	var count int64
	if err := db.Model(&models.RevokedToken{}).Where("jti = ?", jti).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

// findUserByID loads the account for a numeric user id taken from a claim.
func findUserByID(db *gorm.DB, userID string) (*models.User, error) {
	idUint, err := strconv.ParseUint(userID, 10, 64)
	if err != nil {
		return nil, err
	}
	var user models.User
	if err := db.First(&user, idUint).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

// refreshSubject validates a refresh token — signature/expiry, single-use
// check, user lookup — and returns the JTI + expiry needed for the
// revocation record.
func refreshSubject(db *gorm.DB, jwtService *services.JWTService, token string) (string, time.Time, *models.User, error) {
	claims, err := jwtService.ParseRefreshToken(token)
	if err != nil {
		return "", time.Time{}, nil, errTokenInvalid
	}

	used, err := isRevoked(db, claims.ID)
	if err != nil {
		return "", time.Time{}, nil, err
	}
	if used {
		return "", time.Time{}, nil, errTokenInvalid
	}

	user, err := findUserByID(db, claims.Subject)
	if err != nil {
		return "", time.Time{}, nil, errTokenInvalid
	}

	expiry := time.Now()
	if claims.ExpiresAt != nil {
		expiry = claims.ExpiresAt.Time
	}
	return claims.ID, expiry, user, nil
}

// recordRevocation marks the refresh token as used, then prunes revocation
// rows whose tokens have already expired (best-effort).
func recordRevocation(db *gorm.DB, jti string, expiry time.Time) error {
	if err := db.Create(&models.RevokedToken{JTI: jti, ExpiresAt: expiry}).Error; err != nil {
		return err
	}
	db.Where("expires_at < ?", time.Now()).Delete(&models.RevokedToken{}) // best-effort
	return nil
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

		// 1–3. Validate the token (signature/expiry), reject already-used
		// copies, and load the user.
		jti, expiry, user, err := refreshSubject(db, jwtService, req.RefreshToken)
		if errors.Is(err, errTokenInvalid) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid or expired refresh token"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
			return
		}

		// 4. Revoke the presented token (single-use rotation) + prune
		//    expired revocation rows.
		if err := recordRevocation(db, jti, expiry); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to record token revocation"})
			return
		}

		// 5. Issue the replacement token pair.
		accessToken, refreshToken, err := issueTokens(jwtService, user)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate tokens"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"token":         accessToken,
			"refresh_token": refreshToken,
		})
	}
}
