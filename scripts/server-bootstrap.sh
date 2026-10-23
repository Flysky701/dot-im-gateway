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
source "$ROOT/scripts/server-preflight.sh"
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
select_python || fail python310_required "需要 Python >=3.10；优先用 PYTHON=/已有解释器路径 指定，不必升级系统 Python。"
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

step "3/6 检查源码依赖"
cd "$ROOT"
npm ci --offline --ignore-scripts --no-audit --no-fund >/dev/null

step "4/6 获取单文件连接程序"
VERSION="$(node -p 'require("./package.json").version')"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
[ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || COMMIT=unknown
BIN="$TOOLS/dot-im-connect-linux-x64"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/dot-im-connect-linux-x64"
# The connector must come from exactly the same source commit as the service:
# a Release binary is used only when its build record names this commit. Builds from
# modified files are recorded as "<commit>-dirty" and therefore never match.
built_from(){ node -e 'const m=require(process.argv[1]);process.stdout.write(String(m.sourceCommit||"")+" "+String(m.executableSha256||""))' "$1" 2>/dev/null || true; }
sha(){ sha256sum "$1" | cut -d' ' -f1; }
mkdir -p "$TOOLS"
rm -f "$BIN.next" "$BIN.next.sha256" "$BIN.next.build.json"
if [ -n "${CONNECT_BINARY:-}" ]; then
  [ "$COMMIT" != unknown ] && [ -f "$CONNECT_BINARY" ] \
    && [ "$(built_from "$CONNECT_BINARY.build.json")" = "$COMMIT $(sha "$CONNECT_BINARY")" ] \
    || fail connect_binary_source_mismatch "指定产物需附带同一干净提交的 .build.json 和匹配 SHA256。"
  cp "$CONNECT_BINARY" "$BIN.next"
  cp "$CONNECT_BINARY.build.json" "$BIN.next.build.json"
  step "   使用指定的 CONNECT_BINARY（SHA256 $(sha "$BIN.next")）"
elif [ "$COMMIT" != unknown ] && [ -x "$BIN" ] && [ "$(built_from "$BIN.build.json")" = "$COMMIT $(sha "$BIN")" ]; then
  step "   已有与提交 ${COMMIT:0:12} 一致的连接程序，跳过下载"
elif [ "$COMMIT" != unknown ] && fetch "$URL" "$BIN.next" 2>/dev/null && fetch "$URL.sha256" "$BIN.next.sha256" 2>/dev/null \
  && fetch "$URL.build.json" "$BIN.next.build.json" 2>/dev/null \
  && [ "$(cut -d' ' -f1 "$BIN.next.sha256")" = "$(sha "$BIN.next")" ] \
  && [ "$(built_from "$BIN.next.build.json")" = "$COMMIT $(sha "$BIN.next")" ]; then
  step "   使用 GitHub Release v${VERSION}（提交 ${COMMIT:0:12}，SHA256 $(sha "$BIN.next")）"
else
  [ "$COMMIT" = unknown ] && step "   源码不是干净的 Git 检出，无法核对 Release 来源" \
    || step "   没有与提交 ${COMMIT:0:12} 对应的已发布 Release"
  rm -f "$BIN.next" "$BIN.next.sha256" "$BIN.next.build.json"
  build_memory_available || fail build_memory_low "可用内存加空闲 swap 不足 1.5 GiB；优先取得匹配产物或换构建环境，不自动改 swap。"
  step "   按固定依赖在本机构建（需要访问 npm 和 GitHub）"
  npm ci --prefix packaging --ignore-scripts --no-audit --no-fund >/dev/null
  "$PYTHON" packaging/fetch.py >/dev/null
  node packaging/build.js >/dev/null
  cp dist/dot-im-connect-linux-x64 "$BIN.next"; cp dist/dot-im-connect-linux-x64.build.json "$BIN.next.build.json"
fi
if [ -f "$BIN.next" ]; then
  chmod 700 "$BIN.next" && mv "$BIN.next" "$BIN"
  if [ -f "$BIN.next.build.json" ]; then mv "$BIN.next.build.json" "$BIN.build.json"; else rm -f "$BIN.build.json"; fi
fi
rm -f "$BIN.next.sha256"

step "5/6 单文件离线自检"
"$BIN" --self-test >/dev/null || fail self_test_failed

step "6/6 安装常驻服务到 ${PREFIX}"
# Acquire and check the connector before changing an existing service. A missing
# artifact or insufficient build memory must not leave a half-finished upgrade.
if [ -f "$PREFIX/.dot-im-gateway" ] && [ -L "$PREFIX/current" ] && [ -f "$PREFIX/runtime.env" ]; then
  step "   升级当前实例（自动备份，数据和凭据保留）"
  "$PYTHON" scripts/deploy.py upgrade --prefix "$PREFIX" --apply >/dev/null
else
  "$PYTHON" scripts/deploy.py install --prefix "$PREFIX" --apply >/dev/null
fi
LINGER="$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || echo unknown)"
cat <<JSON
{"ready":true,"prefix":"$PREFIX","commit":"$COMMIT","connect_binary":"$BIN","linger":"$LINGER",
 "next":"$BIN --handoff $PREFIX --port $PORT --no-browser",
 "local_forward":"ssh -N -L 127.0.0.1:$PORT:127.0.0.1:$PORT <this-server>"}
JSON
