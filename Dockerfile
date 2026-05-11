# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY pnpm-lock.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm build

# Stage 2: runtime
FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app -u 10001
COPY --from=builder /build/dist /app/dist
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/package.json /app/package.json
RUN mkdir -p /data && chown app:app /data
USER app
VOLUME ["/data"]
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
