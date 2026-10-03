FROM node:26.10.0-alpine3.24 AS builder

WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ===================================================
# astro preview serves dist AND runs the /api proxy + allowedHosts
# from astro.config.mjs — so node_modules must stay (can't swap to a
# plain static server without losing the proxy).
FROM node:26.10.0-alpine3.24

RUN apk add --no-cache ca-certificates \
 && addgroup -g 10001 app \
 && adduser -u 10001 -G app -s /sbin/nologin -D app

WORKDIR /app

COPY --from=builder --chown=app:app \
    /app/dist /app/dist \
    /app/node_modules /app/node_modules \
    /app/package*.json /app/ \
    /app/astro.config.mjs /app/

COPY --from=builder --chown=app:app \
    /app/.astro /app/.astro

USER app

EXPOSE 4321

ENV PORT=4321 \
    HOSTNAME="0.0.0.0"

ARG ALLOWED_HOSTS
ENV ALLOWED_HOSTS=${ALLOWED_HOSTS:-localhost,127.0.0.1}
ARG API_PROXY_TARGET
ENV API_PROXY_TARGET=${API_PROXY_TARGET:-}

CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0"]
