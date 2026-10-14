# Cloud Run image. Bun runs the TypeScript sources directly. Base pulled through Google's Docker Hub
# mirror (no Hub rate limits in Cloud Build), pinned by digest; keep the tag = package.json packageManager.
FROM mirror.gcr.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production

FROM mirror.gcr.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app /app
USER bun
EXPOSE 8080
ENV PORT=8080
CMD ["bun", "packages/app/src/main.ts"]
