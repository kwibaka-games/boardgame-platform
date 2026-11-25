FROM node:24-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund --registry=${NPM_REGISTRY}
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN npm run build && node scripts/sync-games.mjs

FROM node:24-bookworm-slim AS runtime
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry=${NPM_REGISTRY} && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "dist/platform/main.js"]
