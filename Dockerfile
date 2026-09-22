FROM node:22-bookworm-slim AS app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev \
  && npm cache clean --force

COPY . .

RUN npm run build \
  && useradd --create-home --shell /usr/sbin/nologin appuser \
  && mkdir -p /data \
  && chown -R appuser:appuser /app /data \
  && chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "run", "docker-start"]

# Build this target only on an orchestrator that supports Playwright's
# user-namespace seccomp policy. Railway intentionally uses the final,
# browser-free target below.
FROM app AS browser

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npx playwright-core install --with-deps chromium \
  && chown -R appuser:appuser /ms-playwright

# Keep the lean app stage last so a plain `docker build .` (including
# Railway's Dockerfile builder) cannot accidentally bundle Chromium.
FROM app AS railway
