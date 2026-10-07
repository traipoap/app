package controllers

import (
	"exporter/models"
	"net/http"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

func HashPassword(password string) (string, error) {
	// Cost 10 is a practical default for production logins (~10ms per verify).
	// Cost 14 took ~100ms+ and made login feel sluggish for no meaningful
	// security gain on modern hardware.
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), 10)
	return string(bytes), err
}

func HandleRegister(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var input models.CreateUserInput

		// 1. Bind and validate JSON input
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		// 2. Check if user already exists
		var existingUser models.User
		if err := db.Where("username = ?", input.Username).First(&existingUser).Error; err == nil {
			c.JSON(http.StatusConflict, gin.H{"error": "Username already exists"})
			return
		}

		// 3. Hash the password
		hashedPassword, err := HashPassword(input.Password)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to process password"})
			return
		}

		// 4. Create new user instance.
		// Role is ALWAYS "user": self-registration must not be able to grant
		// elevated roles ("admin") — that would let a client escalate itself.
		// Elevated accounts are provisioned by an operator out-of-band.
		newUser := models.User{
			Username:     input.Username,
			PasswordHash: hashedPassword,
			Role:         "user",
		}

		// 5. Save to SQLite database
		if err := db.Create(&newUser).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create user"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"message": "User created successfully",
			"user_id": newUser.ID,
		})
	}
}
