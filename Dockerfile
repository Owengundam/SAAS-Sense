FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev \
  && npx playwright-core install --with-deps chromium \
  && npm cache clean --force

COPY . .

RUN npm run build \
  && useradd --create-home --shell /usr/sbin/nologin appuser \
  && mkdir -p /data /ms-playwright \
  && chown -R appuser:appuser /app /data \
  && chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "run", "docker-start"]
