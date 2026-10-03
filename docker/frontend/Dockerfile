# syntax=docker/dockerfile:1.7

# ---- builder ----
FROM node:26.10.0-alpine3.24 AS builder

WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci --omit=dev

COPY frontend/ .
RUN npm run build

# ---- runtime (nginx serve static) ----
FROM nginx:1.30.5-alpine3.24

# Pull latest security fixes for the base image's packages from the
# current Alpine 3.24 repos (fixes e.g. pcre2 10.49-r0, libexpat 2.8.5-r0
# so Trivy's scan gate passes).
RUN apk update && apk upgrade --no-cache

COPY --from=builder /app/dist /usr/share/nginx/html

# COPY nginx-proxy.conf /etc/nginx/conf.d/default.conf

USER nginx

EXPOSE 4321

CMD ["nginx", "-g", "daemon off;"]
