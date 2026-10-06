# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Current yt-dlp versions need a JavaScript runtime to read YouTube's player code.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

# The standalone yt-dlp build for this CPU. It stays writable so `yt-dlp -U` can replace it.
RUN mkdir -p /opt/yt-dlp \
  && case "$TARGETARCH" in arm64) asset=yt-dlp_linux_aarch64 ;; *) asset=yt-dlp_linux ;; esac \
  && curl -fsSL -o /opt/yt-dlp/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$asset" \
  && chmod 755 /opt/yt-dlp/yt-dlp

RUN npm install -g pnpm@9.6.0

WORKDIR /app

# Install dependencies in their own layer so code changes do not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV PORT=3000 \
    DATA_DIR=/data \
    WEB_DIR=/app/apps/web/dist \
    YTDLP_BIN=/opt/yt-dlp/yt-dlp

EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
