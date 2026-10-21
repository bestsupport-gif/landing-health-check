#!/bin/bash
# GitHub main 에 새 커밋이 있으면 이미지를 다시 빌드해 컨테이너를 교체한다.
# 사용법: sudo landing-update          (변경 있을 때만)
#         sudo landing-update --force  (무조건 재배포)
set -euo pipefail

APP=/opt/landing-health-check
DATA=/var/lib/landing-health
ENV_FILE=/etc/landing-health.env
NAME=landing-health

cd "$APP"
git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
RUNNING=$(docker ps -q -f "name=^${NAME}$" || true)

if [ "$LOCAL" = "$REMOTE" ] && [ -n "$RUNNING" ] && [ "${1:-}" != "--force" ]; then
  exit 0
fi

git reset -q --hard origin/main
install -m 755 "$APP/deploy/update.sh" /usr/local/bin/landing-update
docker build -t "$NAME" .
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  -p 80:3000 \
  -v "$DATA:/data" \
  --env-file "$ENV_FILE" \
  --shm-size=512m \
  "$NAME"
docker image prune -f >/dev/null
echo "deployed $(git rev-parse --short HEAD)"
