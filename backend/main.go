package main

import (
	"context"
	"errors"
	"exporter/config"
	"exporter/controllers"
	"exporter/models"
	"exporter/routers"
	"exporter/telemetry"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

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

	// Initialize distributed tracing (OTel → OTLP → Collector/Tempo).
	// Best-effort: the API must work even when the collector is down.
	shutdownTracing, tracingEnabled := telemetry.Init(context.Background())

	db := openDB()
	seedDemoUsers(db)
	srv := newServer(db)

	// Graceful shutdown: flush pending spans before closing the listener,
	// so K8s SIGTERM (rolling deploy / Pod eviction) doesn't drop them.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-quit
		log.Println("shutdown signal received — flushing traces and draining connections…")
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if tracingEnabled {
			if err := shutdownTracing(ctx); err != nil {
				log.Printf("trace flush: %v", err)
			}
		}
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("server shutdown: %v", err)
		}
	}()

	log.Printf("##########################################################################################")
	log.Printf("Starting server on port %s", config.AppConfig.Port)
	log.Printf("CORS_ORIGINS: %s", config.AppConfig.CorsOrigins)
	log.Printf("Quickwit_URL: %s", config.AppConfig.QuickwitURL)
	log.Printf("BASE_PATH: %s", filepath.Join(os.Getenv("BASE_PATH"), "exports"))
	log.Printf("Tracing: %v", tracingEnabled)
	log.Printf("##########################################################################################")
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("failed to start server: %v", err)
	}
}

// resolveDBPath returns DATABASE_PATH or the default location.
func resolveDBPath() string {
	if p := os.Getenv("DATABASE_PATH"); p != "" {
		return p
	}
	return "backend/data/users.db"
}

// openDB prepares the directory, opens SQLite and migrates the schema.
func openDB() *gorm.DB {
	dbPath := resolveDBPath()
	if err := os.MkdirAll(filepath.Dir(dbPath), 0755); err != nil {
		log.Fatalf("failed to create database directory: %v", err)
	}
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	if err != nil {
		log.Fatalf("failed to connect database: %v", err)
	}
	if err := db.AutoMigrate(&models.User{}, &models.RevokedToken{}, &models.Resume{}, &models.PublishedResume{}); err != nil {
		log.Fatalf("failed to migrate database: %v", err)
	}
	return db
}

// seedDemoUsers creates the demo admin + user accounts on first start.
func seedDemoUsers(db *gorm.DB) {
	var count int64
	db.Model(&models.User{}).Where("username = ?", "admin@traipoap.com").Count(&count)
	if count > 0 {
		return
	}
	adminHash, err := bcrypt.GenerateFromPassword([]byte("secure-password-admin"), 10)
	userHash, err := bcrypt.GenerateFromPassword([]byte("for-download-my-resume"), 10)
	if err != nil {
		log.Fatalf("failed to hash password: %v", err)
	}
	db.Create(&models.User{
		Username:     "admin@traipoap.com",
		PasswordHash: string(adminHash),
		Role:         "admin",
	})
	db.Create(&models.User{
		Username:     "user@traipoap.com",
		PasswordHash: string(userHash),
		Role:         "user",
	})
	log.Println("Seeded demo admin user")
}

// newServer wires the controllers and routes into an http.Server.
func newServer(db *gorm.DB) *http.Server {
	if err := controllers.InitSearchController(); err != nil {
		log.Fatal("Failed to initialize search controller: ", err)
	}
	if err := controllers.InitExportController(); err != nil {
		log.Fatal("Failed to initialize export controller: ", err)
	}
	r := gin.Default()
	routers.SetupRoutes(r, db)
	return &http.Server{
		Addr:              ":" + config.AppConfig.Port,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}
}
