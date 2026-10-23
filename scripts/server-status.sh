#!/usr/bin/env bash
# Read-only health check of the persistent service. Prints one JSON line and never
# prints secrets, message text or account identifiers. "ok": true means both services
# run, the gateway is live and the official tunnel-client reports ready.
#   bash scripts/server-status.sh            # or: PREFIX=/path bash scripts/server-status.sh
set -uo pipefail
PREFIX="${PREFIX:-$HOME/.local/lib/dot-im-gateway}"
TOOLS="${TOOLS:-$HOME/.local/share/dot-im-gateway-tools}"
NODE="$TOOLS/node-v24.21.0-linux-x64/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node || echo node)"
export PREFIX NODE
exec python3 - <<'PY'
import json, os, subprocess, urllib.request
prefix, node = os.environ['PREFIX'], os.environ['NODE']
def sh(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        return ''
def get(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            return r.status, r.read(4096).decode('utf-8', 'replace')
    except Exception:
        return 0, ''
try:
    with open(os.path.join(prefix, 'config.json'), encoding='utf-8') as f:
        c = json.load(f)
except Exception:
    c = {}
status, body = get(f"http://127.0.0.1:{c.get('port', 8788)}/healthz")
try:
    mode = json.loads(body).get('mode')
except Exception:
    mode = None
try:
    queue = json.loads(sh(node, os.path.join(prefix, 'current/bin/gateway.js'), 'status', '--config', os.path.join(prefix, 'config.json')))
except Exception:
    queue = None
tunnel_hint = None
try:
    with open(os.path.join(prefix, 'tunnel-runtime.env'), encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line.startswith('CONTROL_PLANE_TUNNEL_ID='):
                val = line.split('=', 1)[1].strip("'\"")
                if val.startswith('tunnel_') and len(val) >= 13:
                    tunnel_hint = val[:13] + '...'
except Exception:
    pass
control_plane = None
mcp_requests = 0
h_status, h_body = get('http://127.0.0.1:8790/health?details=true')
if h_status == 200 and h_body:
    try:
        hd = json.loads(h_body)
        control_plane = hd.get('components', {}).get('control-plane', {}).get('state')
        mcp_requests = int(hd.get('components', {}).get('dispatcher', {}).get('details', {}).get('completed', 0))
    except Exception:
        pass
r = {
    'installed': os.path.isfile(os.path.join(prefix, '.dot-im-gateway')),
    'gateway': sh('systemctl', '--user', 'is-active', 'dot-im-gateway.service') or 'unknown',
    'tunnel': sh('systemctl', '--user', 'is-active', 'dot-im-tunnel.service') or 'unknown',
    'gateway_health': status == 200, 'mode': mode,
    'tunnel_ready': get('http://127.0.0.1:8790/readyz')[0] == 200,
    'tunnel_hint': tunnel_hint,
    'control_plane': control_plane,
    'mcp_requests': mcp_requests,
    'platforms': [p for p in ('qq', 'weixin') if c.get(p, {}).get('enabled')],
    'events': bool(c.get('allowSubscriptions')),
    'linger': sh('loginctl', 'show-user', os.environ.get('USER', ''), '--property=Linger', '--value') or 'unknown',
    'queue': queue,
}
r['ok'] = r['gateway'] == 'active' and r['tunnel'] == 'active' and r['gateway_health'] and r['tunnel_ready'] and mode == 'live'
print(json.dumps(r, ensure_ascii=False))
PY
