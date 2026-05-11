# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /build
# corepack reads "packageManager" from package.json to pin pnpm; copying the
# manifest first lets the dep-cache layers reuse across unrelated source edits.
RUN corepack enable
COPY pnpm-lock.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm build

# Stage 2: runtime -- install only production deps (drops ~200 MB of devDeps).
FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable
RUN addgroup -S app && adduser -S app -G app -u 10001
COPY --from=builder /build/dist /app/dist
COPY --from=builder /build/pnpm-lock.yaml /build/package.json /app/
RUN pnpm install --prod --frozen-lockfile
RUN mkdir -p /data && chown app:app /data
USER app
VOLUME ["/data"]
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
