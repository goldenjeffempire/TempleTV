FROM node:24-slim AS base
RUN npm install -g pnpm@10
WORKDIR /workspace

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY lib/db/package.json ./lib/db/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY artifacts/api-server/package.json ./artifacts/api-server/
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS builder
COPY tsconfig.json tsconfig.base.json ./
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/
RUN pnpm --filter @workspace/api-server run build

FROM node:24-slim AS runner
RUN npm install -g pnpm@10
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /workspace/artifacts/api-server/dist ./dist
COPY --from=builder /workspace/artifacts/api-server/package.json ./package.json
COPY --from=builder /workspace/node_modules ./node_modules

RUN mkdir -p uploads/hls

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
