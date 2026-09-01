FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json .npmrc ./
RUN npm install
COPY tsconfig.server.json ./
COPY src ./src
COPY client ./client
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/smokeyvault.db GOVERNMENT_CATALOG_DB_PATH=/app/data/government-catalog.sqlite
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/client/dist ./client/dist
COPY package.json ./
# /data holds the vault DB; /app/data is the preferred persistent mount for government catalogs.
# Host compose dual-mounts the same volume to both paths so imports survive redeploy.
RUN mkdir -p /data/backups /data/images /app/data
VOLUME ["/data", "/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
