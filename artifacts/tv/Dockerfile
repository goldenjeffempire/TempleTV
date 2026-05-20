FROM node:24-slim AS base
RUN npm install -g pnpm@10
WORKDIR /workspace

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY lib/broadcast-sync/package.json ./lib/broadcast-sync/
COPY lib/broadcast-types/package.json ./lib/broadcast-types/
COPY artifacts/tv/package.json ./artifacts/tv/
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS builder
COPY tsconfig.json tsconfig.base.json ./
COPY lib/ ./lib/
COPY artifacts/tv/ ./artifacts/tv/
ARG VITE_API_URL=""
ARG BASE_PATH="/"
ARG BUILD_VERSION=dev
ARG BUILD_SHA=""
ENV BASE_PATH=${BASE_PATH} \
    NODE_ENV=production \
    VITE_APP_VERSION=${BUILD_VERSION} \
    VITE_BUILD_SHA=${BUILD_SHA}
RUN pnpm --filter @workspace/tv run build

FROM nginx:alpine AS runner
COPY --from=builder /workspace/artifacts/tv/dist/public /usr/share/nginx/html
COPY artifacts/tv/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/index.html || exit 1
CMD ["nginx", "-g", "daemon off;"]
