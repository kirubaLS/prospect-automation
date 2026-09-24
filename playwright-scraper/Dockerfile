# Playwright's official image ships Chromium plus every OS-level dependency
# it needs already installed - avoids hunting down apt packages by hand on
# Render's build image. Version must match package.json's pinned "playwright"
# version exactly, or the npm package and the preinstalled browser mismatch.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
# Browser binaries are already in the base image - skip Playwright's own
# postinstall download to keep the build fast and the image small.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
