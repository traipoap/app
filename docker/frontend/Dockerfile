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
# Lambda-only: keep the read-only-fs-safe configs around and swap them in
# when requested. File-level COPY (not directory) on purpose: a missing file
# then fails loudly at COPY time instead of a silent empty dir + cp error later.
COPY docker/frontend/lambda/nginx.conf /opt/nginx-lambda/nginx.conf
COPY docker/frontend/lambda/default.conf /opt/nginx-lambda/default.conf
# Single line on purpose: BuildKit splices backslash continuations into one
# line, which breaks `if/then/fi` unless every statement ends with `;`.
RUN if [ "$LAMBDA" = "true" ]; then [ -s /opt/nginx-lambda/nginx.conf ] && [ -s /opt/nginx-lambda/default.conf ] && cp /opt/nginx-lambda/nginx.conf /etc/nginx/nginx.conf && cp /opt/nginx-lambda/default.conf /etc/nginx/conf.d/default.conf; fi

USER nginx

# nginx serves on 80 (k8s containerPort/Service targetPort = 80).
# EXPOSE is image metadata only — the Lambda adapter still listens on 4321
# by default (set by the Lambda function's port config, not by this image).
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
