#!/bin/bash
# Ubuntu 24.04 VPS 첫 부팅 스크립트 (Oracle Cloud Always Free / AWS Lightsail 등, x86·ARM 모두).
# 인스턴스 생성 화면의 cloud-init 칸에 이 파일 내용을 그대로 붙여 넣으면 된다.
#  - Oracle: Advanced options → Management → "Paste cloud-init script"
#  - Lightsail: "Add launch script"
#  - Docker 설치, 저장소 클론, 컨테이너 실행 (80 포트)
#  - 접속 비밀번호(ADMIN_PASSWORD) 자동 생성 → /etc/landing-health.env
#  - 10분마다 GitHub main 브랜치 변경을 확인해 자동 재배포
set -euxo pipefail

REPO=https://github.com/bestsupport-gif/landing-health-check.git
APP=/opt/landing-health-check
DATA=/var/lib/landing-health
ENV_FILE=/etc/landing-health.env

# 메모리가 작은 플랜에서 Chromium 이 죽지 않도록 스왑 2GB
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io git openssl
systemctl enable --now docker

# Oracle Cloud 의 Ubuntu 이미지는 iptables 가 22번 외 모든 포트를 막는다 → 80 허용
if [ -f /etc/iptables/rules.v4 ] && ! iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null; then
  iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
  netfilter-persistent save || iptables-save > /etc/iptables/rules.v4
  systemctl restart docker   # Docker 포워딩 규칙을 다시 맨 앞에 넣는다
fi

if [ ! -d "$APP/.git" ]; then git clone "$REPO" "$APP"; fi
mkdir -p "$DATA"
chmod 777 "$DATA"

if [ ! -f "$ENV_FILE" ]; then
  {
    echo "ADMIN_PASSWORD=$(openssl rand -hex 8)"
    echo "BROWSER_CONCURRENCY=2"
    echo "CHECK_CRON=0 */6 * * *"
    echo "SLACK_WEBHOOK_URL="
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

install -m 755 "$APP/deploy/update.sh" /usr/local/bin/landing-update

cat > /etc/systemd/system/landing-update.service <<'EOF'
[Unit]
Description=landing-health-check auto update
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/landing-update
EOF

cat > /etc/systemd/system/landing-update.timer <<'EOF'
[Unit]
Description=landing-health-check auto update every 10 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now landing-update.timer

/usr/local/bin/landing-update --force
