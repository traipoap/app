# syntax=docker/dockerfile:1.7
#
# Lambda-compatible image for the DR failover site (function: gin-api).
#
# AWS Lambda only runs images that implement the Lambda Runtime API.
# The Lambda Web Adapter (awslabs/aws-lambda-adapter) provides it:
# its ENTRYPOINT speaks the API, and it proxies every invocation to
# this app's HTTP server (Gin on :8080) — the app itself is unchanged.
#
# Build:   docker build -t backend:lambda -f docker/lambda/Dockerfile .
# Push:    docker push 881050426069.dkr.ecr.ap-southeast-1.amazonaws.com/backend:lambda
# Deploy:  Lambda console → gin-api → Image → Deploy new image
#
# The plain docker/backend/Dockerfile stays for the K3s deployment
# (ArgoCD) — do not merge the two.

FROM golang:1.27.4-alpine3.24 AS backend-builder

WORKDIR /src

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

# =====================================================
# Adapter base is Amazon Linux 2023 (dnf, not apk).
# Pin the adapter tag after verifying it works.
FROM public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0

RUN dnf install -y --setopt=install_weak_deps=False \
        sqlite-libs ca-certificates tzdata \
    && dnf clean all

WORKDIR /var/task

COPY --from=backend-builder /out/app /var/task/app

ENV GIN_MODE=release \
    BACKEND_PORT=8080 \
    AWS_LAMBDA_ADAPTER_HTTP_PORT=8080 \
    DATABASE_PATH=/tmp/users.db \
    JWT_SECRET="" \
    CORS_ORIGINS="*"

# State on Lambda is ephemeral: /tmp is the 10 GiB per-invocation
# mount, so the SQLite DB and exports/ do NOT survive cold starts.
# This DR site is a degraded mode — see README (Deployment).

CMD ["/var/task/app"]
