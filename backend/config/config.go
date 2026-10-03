package config

import (
	"os"
	"strings"

	"github.com/joho/godotenv"
)

type Settings struct {
	QuickwitURL string
	Port        string
	CorsOrigins []string
	BasePath    string
}

var AppConfig *Settings

func Load() error {
	_ = godotenv.Load()

	AppConfig = &Settings{
		QuickwitURL: envOrDefault("QUICKWIT_URL", "http://127.0.0.1:7280"),
		Port:        envOrDefault("BACKEND_PORT", "8080"),
		CorsOrigins: envList("CORS_ORIGINS", []string{"http://localhost:4321", "http://127.0.0.1:4321"}),
		BasePath:    envOrDefault("BASE_PATH", "./"),
	}
	return loadJWT()
}

func envList(key string, def []string) []string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func envOrDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
