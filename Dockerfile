# Cloud Run image. Bun runs the TypeScript sources directly.
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app /app
USER bun
EXPOSE 8080
ENV PORT=8080
CMD ["bun", "packages/app/src/main.ts"]
