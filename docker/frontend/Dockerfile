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

# Pull latest security fixes for the base image's packages from the
# current Alpine 3.24 repos (fixes e.g. pcre2 10.49-r0, libexpat 2.8.5-r0
# so Trivy's scan gate passes).
RUN apk update && apk upgrade --no-cache

COPY --from=builder /app/dist /usr/share/nginx/html
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter

# COPY nginx-proxy.conf /etc/nginx/conf.d/default.conf

USER nginx

EXPOSE 4321

CMD ["sh", "-c", "if [ -n \"$AWS_LAMBDA_RUNTIME_API\" ]; then mkdir -p /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp && sed \"s|http {|http {\\n    client_body_temp_path /tmp/nginx/client_temp;\\n    proxy_temp_path /tmp/nginx/proxy_temp;\\n    fastcgi_temp_path /tmp/nginx/fastcgi_temp;\\n    uwsgi_temp_path /tmp/nginx/uwsgi_temp;\\n    scgi_temp_path /tmp/nginx/scgi_temp;|\" /etc/nginx/nginx.conf | sed \"s|pid .*/nginx.pid;|pid /tmp/nginx/nginx.pid;|g\" > /tmp/nginx/nginx.conf && exec nginx -c /tmp/nginx/nginx.conf -g \"daemon off;\"; fi; exec nginx -g \"daemon off;\""]
