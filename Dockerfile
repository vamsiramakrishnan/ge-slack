# Cloud Run image. Bun runs the TypeScript sources directly. Base pulled through Google's Docker Hub
# mirror (no Hub rate limits in Cloud Build); keep the tag equal to package.json packageManager.
FROM mirror.gcr.io/oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production

FROM mirror.gcr.io/oven/bun:1.3.14
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app /app
USER bun
EXPOSE 8080
ENV PORT=8080
CMD ["bun", "packages/app/src/main.ts"]
