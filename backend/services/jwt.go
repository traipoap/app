package services

import (
	"errors"
	"time"

	"exporter/config"
	"exporter/models"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type JWTService struct {
	secretKey string
}

func NewJWTService() *JWTService {
	return &JWTService{secretKey: config.Config.SecretKey}
}

func (s *JWTService) GenerateToken(userID, username, role string) (string, error) {
	claims := models.CustomClaims{
		UserID:   userID,
		Username: username,
		Role:     role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(config.Config.Expiration)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			Issuer:    config.Config.Issuer,
			Subject:   userID,
			ID:        uuid.New().String(),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(s.secretKey))
}

func (s *JWTService) GenerateRefreshToken(userID string) (string, error) {
	claims := jwt.RegisteredClaims{
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(config.Config.RefreshExpiration)),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		Issuer:    config.Config.Issuer,
		Subject:   userID,
		ID:        uuid.New().String(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(s.secretKey))
}

func (s *JWTService) ValidateToken(tokenString string) (*models.CustomClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &models.CustomClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(s.secretKey), nil
	})

	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*models.CustomClaims); ok && token.Valid {
		return claims, nil
	}

	return nil, errors.New("invalid token")
}

// ValidateRefreshToken validates a refresh-only JWT (RegisteredClaims, no custom claims).
// Returns the userID extracted from Subject.
func (s *JWTService) ValidateRefreshToken(tokenString string) (string, error) {
	claims, err := s.ParseRefreshToken(tokenString)
	if err != nil {
		return "", err
	}
	return claims.Subject, nil
}

// ParseRefreshToken validates a refresh JWT (signing method, signature,
// expiry) and returns its claims, so callers can enforce server-side
// revocation via the token's JTI (ID claim).
func (s *JWTService) ParseRefreshToken(tokenString string) (*jwt.RegisteredClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &jwt.RegisteredClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(s.secretKey), nil
	})

	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*jwt.RegisteredClaims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid refresh token")
	}

	return claims, nil
}
