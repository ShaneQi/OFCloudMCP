# Read-only OmniFocus MCP connector, as a plain-HTTP Node server.
# Put it behind your own HTTPS reverse proxy. See README "Running on a VPS".
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    CACHE_DIR=/data \
    TIMEZONE=America/Chicago

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "src/server.js"]
