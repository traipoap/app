# syntax=docker/dockerfile:1.7

# ---- builder ----
FROM node:26.10.0-alpine3.24 AS builder

WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci --omit=dev

COPY frontend/ .
RUN npm run build

# ---- runtime (nginx serve static) -----
FROM nginx:1.30.5-alpine3.24

COPY --from=builder /app/dist /usr/share/nginx/html

# COPY nginx-proxy.conf /etc/nginx/conf.d/default.conf

USER nginx

EXPOSE 4321

CMD ["nginx", "-g", "daemon off;"]
