ARG NODE_BASE_IMAGE=node:24-bookworm-slim
FROM ${NODE_BASE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev
# Explicit container bind for Supervisor Ingress; HA host publishing is opt-in.
ENV NODE_ENV=production COACHAI_HOST=0.0.0.0 PORT=8099 COACHAI_DB=/share/coachai/cycling_coach.db
EXPOSE 8099
CMD ["node", "build/server.js"]
