// @ts-check
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { defineConfig } from 'astro/config';

// Where /api/* is forwarded to. Priority (highest first):
//   1. shell env   : API_PROXY_TARGET=http://... npm run dev
//   2. frontend/.env : API_PROXY_TARGET=...   (loaded via dotenv below)
//   3. default     : http://localhost:8080
//
// NOTE: astro.config.mjs is evaluated before Vite loads .env into
// import.meta.env — so we load it explicitly here. We resolve the file
// against this config file's own directory (not process.cwd()) so it
// works even if dev is started from the repo root or elsewhere.

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '.env') });

// http-proxy appends the request path to the target's path, so only the
// origin (scheme + host + port) is valid here — a trailing path such as
// /api/auth/login would break every proxied request.
const API_PROXY_TARGET = (() => {
  const raw = process.env.API_PROXY_TARGET || 'http://localhost:8080';
  try {
    return new URL(raw).origin;
  } catch {
    console.warn(`[astro] API_PROXY_TARGET is not a valid URL, falling back to default: ${raw}`);
    return 'http://localhost:8080';
  }
})();

// Hosts the dev/preview servers accept (Vite host check). Inject the real
// domain at build/run time without editing code, e.g.:
//   ALLOWED_HOSTS="frontend.example.com,.example.com" docker build ...
//   docker run -e ALLOWED_HOSTS=frontend.example.com .
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'localhost,127.0.0.1')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

// https://astro.build/config
export default defineConfig({
  vite: {
    server: {
      proxy: {
        '/api': {
          target: API_PROXY_TARGET,
          changeOrigin: true,
        },
      },
      allowedHosts: ALLOWED_HOSTS // dev / server
    },
    preview: {
      allowedHosts: ALLOWED_HOSTS // preview
    }
  }
});
