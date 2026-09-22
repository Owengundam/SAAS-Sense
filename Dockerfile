FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/local/bin/playwright-chromium
ENV CHROME_DEVEL_SANDBOX=/usr/local/sbin/chrome-devel-sandbox

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev \
  && npx playwright-core install --with-deps chromium \
  && chromium_dir="$(find /ms-playwright -mindepth 1 -maxdepth 1 -type d -name 'chromium-*' ! -name '*headless*' -print -quit)" \
  && test -n "$chromium_dir" \
  && ln -s "$chromium_dir/chrome-linux/chrome" /usr/local/bin/playwright-chromium \
  && install -o root -g root -m 4755 "$chromium_dir/chrome-linux/chrome_sandbox" /usr/local/sbin/chrome-devel-sandbox \
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
