package main

import (
	"exporter/config"
	"exporter/controllers"
	"exporter/models"
	"exporter/routers"
	"log"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func main() {
	// Load configuration (env / .env) before anything else
	if err := config.Load(); err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	// Get database path from environment variable
	dbPath := os.Getenv("DATABASE_PATH")
	if dbPath == "" {
		dbPath = "backend/data/users.db" // default path
	}

	// Ensure the directory exists
	dbDir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dbDir, 0755); err != nil {
		log.Fatalf("failed to create database directory: %v", err)
	}

	// Initialize Database (SQLite)
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	if err != nil {
		log.Fatalf("failed to connect database: %v", err)
	}

	// Auto-migrate the User table
	if err := db.AutoMigrate(&models.User{}); err != nil {
		log.Fatalf("failed to migrate database: %v", err)
	}

	var count int64
	db.Model(&models.User{}).Where("username = ?", "admin@example.com").Count(&count)
	if count == 0 {
		hash, err := bcrypt.GenerateFromPassword([]byte("admin123"), 10)
		if err != nil {
			log.Fatalf("failed to hash password: %v", err)
		}
		db.Create(&models.User{
			Username:     "admin@example.com",
			PasswordHash: string(hash),
			Role:         "admin",
		})
		log.Println("Seeded demo admin user")
	}

	if err := controllers.InitSearchController(); err != nil {
		log.Fatal("Failed to initialize search controller: ", err)
	}
	if err := controllers.InitExportController(); err != nil {
		log.Fatal("Failed to initialize export controller: ", err)
	}

	r := gin.Default()
	routers.SetupRoutes(r, db)

	log.Printf("##########################################################################################")
	log.Printf("Starting server on port %s", config.AppConfig.Port)
	log.Printf("CORS_ORIGINS: %s", config.AppConfig.CorsOrigins)
	log.Printf("Quickwit_URL: %s", config.AppConfig.QuickwitURL)
	log.Printf("BASE_PATH: %s", filepath.Join(os.Getenv("BASE_PATH"), "exports"))
	log.Printf("##########################################################################################")
	if err := r.Run(":" + config.AppConfig.Port); err != nil {
		log.Fatalf("failed to start server: %v", err)
	}
}
