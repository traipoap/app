# syntax=docker/dockerfile:1.7

FROM golang:1.27.1-alpine3.24 AS backend-builder

WORKDIR /src

# CGO toolchain for go-sqlite3. (git removed — go mod download uses GOPROXY)
RUN apk add --no-cache gcc musl-dev sqlite-dev

COPY backend/go.mod backend/go.sum ./

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY backend/ .

ARG VERSION=unknown

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -trimpath \
      -ldflags="-s -w -X main.Version=${VERSION}" \
      -o /out/app .

# ===================================================

FROM alpine:3.24.2

# One layer: runtime libs + unprivileged user + writable dirs
RUN apk add --no-cache ca-certificates sqlite-libs tzdata \
 && addgroup -g 10001 app \
 && adduser -u 10001 -G app -s /sbin/nologin -D app \
 && mkdir -p /backend/data /backend/exports \
 && chown -R app:app /backend

WORKDIR /backend

COPY --from=backend-builder --chown=app:app /out/app /backend/app
# Only needed if the app actually runs on AWS Lambda — remove otherwise
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 /lambda-adapter /opt/extensions/lambda-adapter

USER app

EXPOSE 8080

ENV GIN_MODE=release \
    BACKEND_PORT=8080 \
    DATABASE_PATH=/backend/data/users.db \
    JWT_SECRET="" \
    BASE_PATH="./"

ARG CORS_ORIGINS
ENV CORS_ORIGINS=${CORS_ORIGINS}

CMD ["/backend/app"]
