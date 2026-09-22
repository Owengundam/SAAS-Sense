FROM node:22-alpine
RUN apk add --no-cache chromium freetype harfbuzz nss openssl ttf-freefont

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
