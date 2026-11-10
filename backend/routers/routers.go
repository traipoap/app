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
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization", "traceparent"},
		ExposeHeaders:    []string{"Content-Length", "traceparent"},
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

	// Public: the owner's published CV — read by the /cv page, which
	// HR visitors open without any token.
	r.GET("/api/resume/published", controllers.HandlePublishedGet(db))

	// Protected routes
	api := r.Group("/api")
	api.Use(middleware.JWTAuth())
	{
		api.GET("/profile", controllers.HandleProfile)
		api.GET("/admin", middleware.RoleAuth("admin"), controllers.HandleAdmin)
		api.POST("/logout", controllers.HandleLogout(db, jwtService))

		// Admin-only CV backend — the owner's resume builder data.
		api.GET("/resume", middleware.RoleAuth("admin"), controllers.HandleResumeGet(db))
		api.PUT("/resume", middleware.RoleAuth("admin"), controllers.HandleResumePut(db))
		api.DELETE("/resume", middleware.RoleAuth("admin"), controllers.HandleResumeDelete(db))

		// Publish the CV store to the public /cv page.
		api.PUT("/resume/published", middleware.RoleAuth("admin"), controllers.HandlePublishedPut(db))
		api.DELETE("/resume/published", middleware.RoleAuth("admin"), controllers.HandlePublishedDelete(db))

		// User administration (admin only)
		api.GET("/users", middleware.RoleAuth("admin"), controllers.HandleUsersList(db))
		api.DELETE("/users/:id", middleware.RoleAuth("admin"), controllers.HandleUserDelete(db))
		api.PATCH("/users/:id/role", middleware.RoleAuth("admin"), controllers.HandleUserRoleUpdate(db))
	}
}

// setupAPIRoutes configures API-related routes
func setupAPIRoutes(r *gin.Engine, jwtService *services.JWTService) {
	r.GET("/metrics", HandleHome)
	api := r.Group("/api")
	api.Use(middleware.JWTAuth())
	{
		api.GET("/engines", middleware.RoleAuth("admin"), controllers.HandleEngines)
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

	// Configure middleware — OTel tracing first so every request (including
	// rejected auth attempts) lands in the trace.
	r.Use(middleware.HTTP(), cors.New(setupCORS()))

	// Setup route groups
	setupAuthRoutes(r, jwtService, db)
	setupAPIRoutes(r, jwtService)
}
