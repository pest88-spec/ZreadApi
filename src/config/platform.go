package config

import (
	"os"
	"strings"
)

// PlatformConfig 平台配置
type PlatformConfig struct {
	ID               string
	Name             string
	Brand            string
	HomeURL          string
	OriginBase       string
	APIBase          string
	RefererPrefix    string
	ChatURL          string
	ModelsURL        string
	AuthURL          string
	OwnedBy          string
	TokenHeader      string
	DefaultModelID   string
	XFEVersion       string
}

// DetectPlatform 检测平台类型
func DetectPlatform() *PlatformConfig {
	platformID := getEnv("PLATFORM_ID", "zai")
	providerHomeURL := getEnv("PROVIDER_HOME_URL", "")

	// 根据 PLATFORM_ID 或 URL 自动检测平台
	isZread := platformID == "zread" || strings.Contains(providerHomeURL, "zread.ai")

	if isZread {
		return &PlatformConfig{
			ID:               "zread",
			Name:             getEnv("PROVIDER_NAME", "zread.ai"),
			Brand:            getEnv("PROVIDER_BRAND", "zread.ai"),
			HomeURL:          getEnv("PROVIDER_HOME_URL", "https://zread.ai"),
			OriginBase:       getEnv("ORIGIN_BASE", "https://zread.ai"),
			APIBase:          getEnv("PLATFORM_API_BASE", "https://zread.ai"),
			RefererPrefix:    getEnv("REFERER_PREFIX", "/chat/"),
			ChatURL:          getEnv("UPSTREAM_URL", "https://zread.ai/api/chat/completions"),
			ModelsURL:        getEnv("MODELS_URL", "https://zread.ai/v1/models"),
			AuthURL:          getEnv("AUTH_URL", "https://zread.ai/api/v1/auths/"),
			OwnedBy:          getEnv("OWNED_BY", "zread.ai"),
			TokenHeader:      getEnv("PLATFORM_TOKEN_HEADER", "Authorization"),
			DefaultModelID:   getEnv("UPSTREAM_MODEL_ID_DEFAULT", "glm-4.5"),
			XFEVersion:       getEnv("X_FE_VERSION", "prod-fe-1.0.94"),
		}
	}

	return &PlatformConfig{
		ID:               "zai",
		Name:             getEnv("PROVIDER_NAME", "Z.ai"),
		Brand:            getEnv("PROVIDER_BRAND", "Z.ai"),
		HomeURL:          getEnv("PROVIDER_HOME_URL", "https://chat.z.ai"),
		OriginBase:       getEnv("ORIGIN_BASE", "https://chat.z.ai"),
		APIBase:          getEnv("PLATFORM_API_BASE", "https://chat.z.ai"),
		RefererPrefix:    getEnv("REFERER_PREFIX", "/c/"),
		ChatURL:          getEnv("UPSTREAM_URL", "https://chat.z.ai/api/chat/completions"),
		ModelsURL:        getEnv("MODELS_URL", "https://chat.z.ai/v1/models"),
		AuthURL:          getEnv("AUTH_URL", "https://chat.z.ai/api/v1/auths/"),
		OwnedBy:          getEnv("OWNED_BY", "z.ai"),
		TokenHeader:      getEnv("PLATFORM_TOKEN_HEADER", "Authorization"),
		DefaultModelID:   getEnv("UPSTREAM_MODEL_ID_DEFAULT", "0727-360B-API"),
		XFEVersion:       getEnv("X_FE_VERSION", "prod-fe-1.0.94"),
	}
}

// getEnv 获取环境变量，提供默认值
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}