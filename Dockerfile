# Prospecting web app (Apollo.io source) - no browser, ~100MB RAM.
# Build context is the repo root so projects/ ships inside the image;
# adding a project = git push -> Render redeploys.

# 1) build the React frontend
FROM node:20-slim AS web
WORKDIR /web
COPY playwright-scraper/web/package.json playwright-scraper/web/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY playwright-scraper/web ./
RUN npm run build

# 2) the server
FROM node:20-slim
WORKDIR /app/playwright-scraper
COPY playwright-scraper/package.json playwright-scraper/package-lock.json* ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

COPY playwright-scraper/src ./src
COPY --from=web /web/dist ./web/dist
COPY projects /app/projects

ENV NODE_ENV=production
ENV PROJECTS_DIR=/app/projects
EXPOSE 3000
CMD ["node", "src/app.js"]
