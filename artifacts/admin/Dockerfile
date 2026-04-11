FROM node:24-slim AS base
RUN npm install -g pnpm@10
WORKDIR /workspace

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY artifacts/admin/package.json ./artifacts/admin/
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS builder
COPY tsconfig.json tsconfig.base.json ./
COPY lib/ ./lib/
COPY artifacts/admin/ ./artifacts/admin/
ARG VITE_API_URL=""
ENV BASE_PATH=/admin PORT=3000 NODE_ENV=production
RUN pnpm --filter @workspace/admin run build

FROM nginx:alpine AS runner
COPY --from=builder /workspace/artifacts/admin/dist/public /usr/share/nginx/html/admin
COPY artifacts/admin/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
