#!/usr/bin/env bash
# Builds the arm64 image here and runs it on the Raspberry Pi, which is too small to build it.
#
#   scripts/deploy-pi.sh          deploy the current code
#   scripts/deploy-pi.sh --env    also replace the Pi's .env with this one
#
# DEPLOY_HOST and DEPLOY_DIR pick a different Pi or folder.
set -euo pipefail

host="${DEPLOY_HOST:-pi@pi-linhng}"
dir="${DEPLOY_DIR:-music-station}"
image="music-station-app:latest"

cd "$(dirname "$0")/.."

echo "==> Building $image for arm64"
docker buildx build --platform linux/arm64 -f docker/Dockerfile -t "$image" --load .

echo "==> Copying compose file to $host:$dir"
ssh "$host" "mkdir -p $dir/data/app"
rsync -a docker-compose.yml "$host:$dir/"
if [[ "${1:-}" == "--env" ]]; then
  rsync -a --chmod=600 .env "$host:$dir/"
fi

echo "==> Sending image"
docker save "$image" | gzip | ssh "$host" "gunzip | docker load"

echo "==> Restarting"
ssh "$host" "cd $dir && docker compose up -d --no-build --remove-orphans && docker image prune -f >/dev/null && docker compose ps"
