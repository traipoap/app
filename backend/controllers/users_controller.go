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

// actorIsUser reports whether the authenticated actor is the referenced user.
func actorIsUser(c *gin.Context, id uint) bool {
	actorID, _ := c.Get("userID")
	return actorID == strconv.FormatUint(uint64(id), 10)
}

// HandleUsersList lists all registered accounts (admin only).
func HandleUsersList(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var users []models.User
		if err := db.Order("id ASC").Find(&users).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list users"})
			return
		}
		out := make([]userSummary, 0, len(users))
		for _, u := range users {
			out = append(out, toUserSummary(u))
		}
		c.JSON(http.StatusOK, out)
	}
}

// HandleUserDelete removes an account (admin only).
// Guards: no self-delete, and never the last admin.
func HandleUserDelete(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := strconv.ParseUint(c.Param("id"), 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid user id"})
			return
		}

		var target models.User
		if err := db.First(&target, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
			return
		}

		if actorIsUser(c, target.ID) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot delete your own account"})
			return
		}

		if target.Role == "admin" {
			if admins, _ := countAdmins(db); admins <= 1 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot delete the last admin"})
				return
			}
		}

		if err := db.Delete(&target).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete user"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "User deleted"})
	}
}

// HandleUserRoleUpdate changes an account's role (admin only).
// Guards: no self role-change, and never demote the last admin.
func HandleUserRoleUpdate(db *gorm.DB) gin.HandlerFunc {
	type roleInput struct {
		Role string `json:"role" binding:"required,oneof=admin user"`
	}
	return func(c *gin.Context) {
		id, err := strconv.ParseUint(c.Param("id"), 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid user id"})
			return
		}

		var input roleInput
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "role must be 'admin' or 'user'"})
			return
		}

		var target models.User
		if err := db.First(&target, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
			return
		}

		if target.Role == input.Role {
			c.JSON(http.StatusOK, toUserSummary(target))
			return
		}

		if actorIsUser(c, target.ID) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot change your own role"})
			return
		}

		if target.Role == "admin" && input.Role == "user" {
			if admins, _ := countAdmins(db); admins <= 1 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot demote the last admin"})
				return
			}
		}

		target.Role = input.Role
		if err := db.Save(&target).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update role"})
			return
		}
		c.JSON(http.StatusOK, toUserSummary(target))
	}
}
