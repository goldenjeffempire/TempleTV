FROM node:22-alpine AS builder
WORKDIR /repo
RUN apk add --no-cache python3 make g++
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY lib ./lib
COPY artifacts/api-server ./artifacts/api-server
RUN pnpm install --frozen-lockfile --filter @workspace/api-server... --filter @workspace/db...
RUN pnpm --filter @workspace/api-server run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV MALLOC_ARENA_MAX=2
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /repo/artifacts/api-server/dist ./dist
COPY --from=builder /repo/artifacts/api-server/package.json ./package.json
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--enable-source-maps", "--import", "./dist/instrument.mjs", "./dist/index.mjs"]
