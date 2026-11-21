# syntax=docker/dockerfile:1.7

# ---- builder ----
# Pin linux/amd64 so the image matches the cluster/ECR target no matter
# which machine builds it (e.g. an Apple Silicon Mac).
FROM node:26.10.0-alpine3.24 AS builder

WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci --omit=dev

COPY frontend/ .
RUN npm run build

# ---- runtime (nginx serve static) -----
FROM nginx:1.30.7-alpine3.24

# Lambda build: docker build --build-arg LAMBDA=true ...
# On Lambda the filesystem is read-only except /tmp, so the configs in
# lambda/ redirect everything nginx writes (pid, logs, temp paths) to /tmp.
ARG LAMBDA=false

# Pull latest security fixes for the base image's packages from the
# current Alpine 3.24 repos (fixes e.g. pcre2 10.49-r0, libexpat 2.8.5-r0
# so Trivy's scan gate passes).
RUN apk update && apk upgrade --no-cache

COPY --from=builder /app/dist /usr/share/nginx/html
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter
# NOTE: build context is the repo root (see pipeline: `docker build -f docker/frontend/Dockerfile .`),
# so COPY sources must be repo-root-relative.
COPY docker/frontend/default.conf /etc/nginx/conf.d/default.conf
# Lambda-only: swap in the read-only-fs-safe configs (pid/logs/temp → /tmp).
COPY docker/frontend/lambda/ /opt/nginx-lambda/
RUN if [ "$LAMBDA" = "true" ]; then \
        cp /opt/nginx-lambda/nginx.conf /etc/nginx/nginx.conf && \
        cp /opt/nginx-lambda/default.conf /etc/nginx/conf.d/default.conf \
    fi

USER nginx

EXPOSE 4321

CMD ["nginx", "-g", "daemon off;"]
