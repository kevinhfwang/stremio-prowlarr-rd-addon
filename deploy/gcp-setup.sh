#!/usr/bin/env bash
# GCP e2-micro 一键初始化脚本
# 在 GCP 虚拟机网页 SSH 里执行（以普通用户身份）：
#
#   curl -fsSL https://raw.githubusercontent.com/kevinhfwang/stremio-prowlarr-rd-addon/main/deploy/gcp-setup.sh | bash -s -- stremio.你的域名.com prowlarr.你的域名.com
#
# 前置条件：
#   1. DNS 的 A 记录已指向本机外部 IP（Caddy 签证书用，可用临时 IP 先跑，签证书前必须生效）
#   2. GCP 防火墙已放行 80/443（建 VM 时勾选 Allow HTTP/HTTPS 即可）
set -euo pipefail

STREMIO_DOMAIN="${1:-}"
PROWLARR_DOMAIN="${2:-}"
if [[ -z "$STREMIO_DOMAIN" || -z "$PROWLARR_DOMAIN" ]]; then
  echo "用法: $0 <stremio_domain> <prowlarr_domain>" >&2
  exit 1
fi

echo "==> [1/5] 创建 2GB swap（e2-micro 只有 1GB 内存，必加）"
if ! swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf >/dev/null
  sudo sysctl -p >/dev/null
fi

echo "==> [2/5] 安装 Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi

echo "==> [3/5] 拉取项目"
cd "$HOME"
rm -rf stremio-prowlarr-rd-addon
git clone --depth 1 https://github.com/kevinhfwang/stremio-prowlarr-rd-addon.git
cd stremio-prowlarr-rd-addon

cat > .env <<EOF
STREMIO_DOMAIN=$STREMIO_DOMAIN
PROWLARR_DOMAIN=$PROWLARR_DOMAIN
EOF

echo "==> [4/5] 启动 Prowlarr + 插件 + Caddy（首次拉镜像约 2-3 分钟）"
sudo docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d

echo "==> [5/5] 完成 ✅"
echo ""
echo "  Prowlarr 管理界面:  https://$PROWLARR_DOMAIN"
echo "  Stremio 配置页面:   https://$STREMIO_DOMAIN/configure"
echo ""
echo "别忘了："
echo "  1. 打开 Prowlarr → Settings → General → 开启 Forms Login 认证并记下 API Key"
echo "  2. Settings → Indexers → 添加索引器（成人站选 Sukebei，分类勾 6000）"
