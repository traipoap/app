package routers

import (
	"exporter/config"
	"exporter/controllers"
	"exporter/middleware"
	"exporter/services"
	"net/http"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// HandleHome returns a welcome message with API usage information
func HandleHome(c *gin.Context) {
	port := config.AppConfig.Port
	c.String(http.StatusOK, "Dummy Quickwit API is running\n"+
		"Try: http://localhost:%s/api/v1/syslogs/search?query=8.8.8.8&max_hits=5", port)
}

func setupCORS() cors.Config {
	return cors.Config{
		AllowOrigins:     config.AppConfig.CorsOrigins,
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	}
}

// setupAuthRoutes configures authentication routes
func setupAuthRoutes(r *gin.Engine, jwtService *services.JWTService, db *gorm.DB) {
	// Public routes
	auth := r.Group("/api/auth")
	{
		auth.POST("/login", controllers.HandleSignIn(db, jwtService))
		auth.POST("/refresh", controllers.HandleRefresh(db, jwtService))
		auth.POST("/register", controllers.HandleRegister(db))
	}

	// Protected routes
	api := r.Group("/api")
	api.Use(middleware.JWTAuth())
	{
		api.GET("/profile", controllers.HandleProfile)
		api.GET("/admin", middleware.RoleAuth("admin"), controllers.HandleAdmin)
		api.POST("/logout", controllers.HandleLogout)
	}
}

// setupAPIRoutes configures API-related routes
func setupAPIRoutes(r *gin.Engine, jwtService *services.JWTService) {
	r.GET("/metrics", HandleHome)
	api := r.Group("/api")
	api.Use(middleware.JWTAuth())
	{
		api.GET("/indices", middleware.RoleAuth("admin"), controllers.HandleIndices)
		api.GET("/search", middleware.RoleAuth("admin"), controllers.HandleSearch)
		api.GET("/export", middleware.RoleAuth("admin"), controllers.HandleExport)
		api.GET("/exports", middleware.RoleAuth("admin"), controllers.HandleExportsList)
		api.DELETE("/exports/:filename", middleware.RoleAuth("admin"), controllers.HandleDeleteExport)
		api.GET("/exports/:filename", middleware.RoleAuth("admin"), controllers.HandleDownload)
	}
}

// SetupRoutes configures all routes for the application
func SetupRoutes(r *gin.Engine, db *gorm.DB) {

	jwtService := services.NewJWTService()

	// Configure middleware
	r.Use(cors.New(setupCORS()))

	// Setup route groups
	setupAuthRoutes(r, jwtService, db)
	setupAPIRoutes(r, jwtService)
}
