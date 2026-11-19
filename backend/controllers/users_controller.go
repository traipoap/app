package controllers

import (
	"net/http"
	"strconv"

	"exporter/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// userSummary is the public representation of an account — it never
// exposes the password hash.
type userSummary struct {
	ID       uint   `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

func toUserSummary(u models.User) userSummary {
	return userSummary{ID: u.ID, Username: u.Username, Role: u.Role}
}

func countAdmins(db *gorm.DB) (int64, error) {
	var n int64
	err := db.Model(&models.User{}).Where("role = ?", "admin").Count(&n).Error
	return n, err
}

// guardLastAdmin reports the given error message when touching `target`
// would leave the system with zero admins.
func guardLastAdmin(db *gorm.DB, target models.User, message string) (string, bool) {
	if target.Role != "admin" {
		return "", false
	}
	admins, _ := countAdmins(db)
	if admins <= 1 {
		return message, true
	}
	return "", false
}

// actorIsUser reports whether the authenticated actor is the referenced user.
func actorIsUser(c *gin.Context, id uint) bool {
	actorID, _ := c.Get("userID")
	return actorID == strconv.FormatUint(uint64(id), 10)
}

// parseUserID reads the :id path parameter.
func parseUserID(c *gin.Context) (uint, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		return 0, false
	}
	return uint(id), true
}

// loadUser fetches an account by id.
func loadUser(db *gorm.DB, id uint) (*models.User, error) {
	var target models.User
	if err := db.First(&target, id).Error; err != nil {
		return nil, err
	}
	return &target, nil
}

// roleChangeBlocked returns the message that blocks a role change
// (self-change, or demoting the last admin), or "" when allowed.
func roleChangeBlocked(c *gin.Context, db *gorm.DB, target *models.User, newRole string) string {
	if actorIsUser(c, target.ID) {
		return "Cannot change your own role"
	}
	if newRole == "user" {
		if msg, blocked := guardLastAdmin(db, *target, "Cannot demote the last admin"); blocked {
			return msg
		}
	}
	return ""
}

// targetIsSelf reports whether the referenced account belongs to the
// authenticated actor (with a ready-to-send 400 message).
func targetIsSelf(c *gin.Context, target *models.User, message string) (string, bool) {
	if actorIsUser(c, target.ID) {
		return message, true
	}
	return "", false
}

// summarizeUsers maps accounts onto the public summary shape.
func summarizeUsers(users []models.User) []userSummary {
	out := make([]userSummary, 0, len(users))
	for _, u := range users {
		out = append(out, toUserSummary(u))
	}
	return out
}

// HandleUsersList lists all registered accounts (admin only).
func HandleUsersList(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var users []models.User
		if err := db.Order("id ASC").Find(&users).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list users"})
			return
		}
		c.JSON(http.StatusOK, summarizeUsers(users))
	}
}

// HandleUserDelete removes an account (admin only).
// Guards: no self-delete, and never the last admin.
func HandleUserDelete(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseUserID(c)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid user id"})
			return
		}

		target, err := loadUser(db, id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
			return
		}

		if msg, blocked := targetIsSelf(c, target, "Cannot delete your own account"); blocked {
			c.JSON(http.StatusBadRequest, gin.H{"error": msg})
			return
		}

		if msg, blocked := guardLastAdmin(db, *target, "Cannot delete the last admin"); blocked {
			c.JSON(http.StatusBadRequest, gin.H{"error": msg})
			return
		}

		if err := db.Delete(target).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete user"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "User deleted"})
	}
}

// roleInput is the PATCH body for a role change.
type roleInput struct {
	Role string `json:"role" binding:"required,oneof=admin user"`
}

// HandleUserRoleUpdate changes an account's role (admin only).
// Guards: no self role-change, and never demote the last admin.
func HandleUserRoleUpdate(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, ok := parseUserID(c)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid user id"})
			return
		}

		var input roleInput
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "role must be 'admin' or 'user'"})
			return
		}

		target, err := loadUser(db, id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
			return
		}

		// No-op: the role is unchanged.
		if target.Role == input.Role {
			c.JSON(http.StatusOK, toUserSummary(*target))
			return
		}

		if msg := roleChangeBlocked(c, db, target, input.Role); msg != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": msg})
			return
		}

		target.Role = input.Role
		if err := db.Save(target).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update role"})
			return
		}
		c.JSON(http.StatusOK, toUserSummary(*target))
	}
}
