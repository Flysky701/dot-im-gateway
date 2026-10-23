#!/usr/bin/env bash
# One command to prepare a Linux server for the persistent dot-im-gateway service.
# Run it from a checkout pinned to a reviewed commit; it is idempotent and safe to rerun.
# Rerunning after checking out a newer commit upgrades an existing bound service.
#   bash scripts/server-bootstrap.sh            # prepare (no QQ/Weixin/OpenAI credentials touched)
#   PREFIX=/path bash scripts/server-bootstrap.sh
# It never asks for or stores credentials. Binding happens afterwards in the
# single-file page started with --handoff, which hands the result to this service.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${PREFIX:-$HOME/.local/lib/dot-im-gateway}"
TOOLS="${TOOLS:-$HOME/.local/share/dot-im-gateway-tools}"
REPO="${REPO:-Flysky701/dot-im-gateway}"
NODE_VERSION=24.21.0
NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
PORT="${PORT:-8789}"

step(){ printf '[dot-im-gateway] %s\n' "$*"; }
fail(){ printf '[dot-im-gateway] STOP: %s\n' "$1" >&2; [ -n "${2:-}" ] && printf '[dot-im-gateway] HINT: %s\n' "$2" >&2; exit 1; }
fetch(){ if command -v curl >/dev/null; then curl -fsSL --retry 3 -o "$2" "$1"; else wget -q -O "$2" "$1"; fi; }

step "1/6 检查系统"
[ "$(uname -s)" = Linux ] || fail linux_required "常驻服务只支持 Linux 服务器；Windows 请使用单文件一次性连接。"
[ "$(uname -m)" = x86_64 ] || fail x86_64_required "当前只发布 Linux x64。"
[ "$(id -u)" != 0 ] || fail run_as_normal_user "请用普通用户运行（服务以 systemd --user 运行，不需要 root）。"
command -v systemctl >/dev/null || fail systemd_required
systemctl --user show-environment >/dev/null 2>&1 || fail user_systemd_unavailable \
  "用该用户的 SSH 登录会话运行；如仍失败，执行 sudo loginctl enable-linger $USER 后重新登录。"
command -v python3 >/dev/null || fail python3_required "安装 python3 (>=3.10)，例如 sudo apt install -y python3。"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' || fail python310_required
command -v curl >/dev/null || command -v wget >/dev/null || fail curl_required "安装 curl，例如 sudo apt install -y curl。"
command -v tar >/dev/null && command -v xz >/dev/null || fail tar_xz_required "安装 xz，例如 sudo apt install -y xz-utils。"

step "2/6 准备固定版本 Node ${NODE_VERSION}（只装在 ${TOOLS}，不改系统）"
NODE_DIR="$TOOLS/node-v${NODE_VERSION}-linux-x64"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  mkdir -p "$TOOLS"; tmp="$(mktemp -d "$TOOLS/.node.XXXXXX")"
  fetch "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" "$tmp/node.tar.xz"
  echo "${NODE_SHA256}  $tmp/node.tar.xz" | sha256sum -c --quiet - || fail node_checksum_mismatch
  tar -xJf "$tmp/node.tar.xz" -C "$tmp" && mv "$tmp/node-v${NODE_VERSION}-linux-x64" "$NODE_DIR" && rm -rf "$tmp"
fi
export PATH="$NODE_DIR/bin:$PATH"
[ "$(node --version)" = "v${NODE_VERSION}" ] || fail node_version_mismatch

step "3/6 离线自检并安装常驻服务到 ${PREFIX}"
cd "$ROOT"
npm ci --offline --ignore-scripts --no-audit --no-fund >/dev/null
if [ -f "$PREFIX/.dot-im-gateway" ] && [ -L "$PREFIX/current" ] && [ -f "$PREFIX/runtime.env" ]; then
  # Already bound and running: switch to this commit with an automatic backup.
  step "   已有在用的常驻服务：升级到当前提交（自动备份，数据和凭据保留）"
  python3 scripts/deploy.py upgrade --prefix "$PREFIX" --apply >/dev/null
else
  python3 scripts/deploy.py install --prefix "$PREFIX" --apply >/dev/null
fi

step "4/6 获取单文件连接程序"
VERSION="$(node -p 'require("./package.json").version')"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
BIN="$TOOLS/dot-im-connect-linux-x64"
if [ -n "${CONNECT_BINARY:-}" ]; then
  cp "$CONNECT_BINARY" "$BIN.next"
elif fetch "https://github.com/${REPO}/releases/download/v${VERSION}/dot-im-connect-linux-x64" "$BIN.next" 2>/dev/null \
  && fetch "https://github.com/${REPO}/releases/download/v${VERSION}/dot-im-connect-linux-x64.sha256" "$BIN.sha256" 2>/dev/null; then
  expected="$(cut -d' ' -f1 "$BIN.sha256")"; actual="$(sha256sum "$BIN.next" | cut -d' ' -f1)"
  [ "$expected" = "$actual" ] || fail release_checksum_mismatch
  step "   使用 GitHub Release v${VERSION}（SHA256 ${actual}）"
else
  step "   没有可用的 Release，按固定依赖在本机构建（约 1–3 分钟）"
  rm -f "$BIN.next"
  npm ci --prefix packaging --ignore-scripts --no-audit --no-fund >/dev/null
  python3 packaging/fetch.py >/dev/null
  node packaging/build.js >/dev/null
  cp dist/dot-im-connect-linux-x64 "$BIN.next"
fi
chmod 700 "$BIN.next" && mv "$BIN.next" "$BIN"

step "5/6 单文件离线自检"
"$BIN" --self-test >/dev/null || fail self_test_failed

step "6/6 完成"
LINGER="$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || echo unknown)"
cat <<JSON
{"ready":true,"prefix":"$PREFIX","commit":"$COMMIT","connect_binary":"$BIN","linger":"$LINGER",
 "next":"$BIN --handoff $PREFIX --port $PORT --no-browser",
 "local_forward":"ssh -N -L 127.0.0.1:$PORT:127.0.0.1:$PORT <this-server>"}
JSON
