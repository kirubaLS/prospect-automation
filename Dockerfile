# Prospecting web app (Apollo.io source) - no browser, ~100MB RAM.
# Build context is the repo root so projects/ ships inside the image;
# adding a project = git push -> Render redeploys.
FROM node:20-slim

WORKDIR /app/playwright-scraper
COPY playwright-scraper/package.json playwright-scraper/package-lock.json* ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

COPY playwright-scraper/src ./src
COPY projects /app/projects

ENV NODE_ENV=production
ENV PROJECTS_DIR=/app/projects
EXPOSE 3000
CMD ["node", "src/app.js"]
