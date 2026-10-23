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
import json, os, re, sqlite3, subprocess, time, urllib.request
from pathlib import Path
from contextlib import closing
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
tunnel_hint = tunnel_id = None
try:
    with open(os.path.join(prefix, 'tunnel-runtime.env'), encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line.startswith('CONTROL_PLANE_TUNNEL_ID='):
                val = line.split('=', 1)[1].strip("'\"")
                if re.fullmatch(r'tunnel_[A-Za-z0-9_-]{7,128}', val):
                    tunnel_id = val
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
    'tunnel_id': tunnel_id,
    'control_plane': control_plane,
    'mcp_requests': mcp_requests,
    'platforms': [p for p in ('qq', 'weixin') if c.get(p, {}).get('enabled')],
    'events': bool(c.get('allowSubscriptions')),
    'linger': sh('loginctl', 'show-user', os.environ.get('USER', ''), '--property=Linger', '--value') or 'unknown',
    'queue': queue,
}
r['ok'] = r['gateway'] == 'active' and r['tunnel'] == 'active' and r['gateway_health'] and r['tunnel_ready'] and mode == 'live'
# Read-only aggregate evidence. Never select message text, owners, callback URLs,
# subscription secrets or provider IDs. Keep legacy queue/ok fields unchanged.
setup = {p: {'bound': bool(c.get(p, {}).get('enabled') and c.get(p, {}).get('ownerId')),
             'active_subscriptions': None, 'replies': None} for p in ('qq', 'weixin')}
try:
    database = Path(prefix, c.get('dataDir', 'data'), 'gateway.sqlite').resolve()
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=1)) as db:
        for p, evidence in setup.items():
            evidence['active_subscriptions'] = db.execute(
                'SELECT count(*) FROM subscriptions WHERE platform=? AND active=1 AND expires>?',
                (p, int(time.time() * 1000))).fetchone()[0]
            evidence['replies'] = [dict(phase=phase, state=state, count=count) for phase, state, count in db.execute(
                "SELECT r.phase,r.state,count(*) FROM replies r JOIN messages m ON m.id=r.message_id "
                "WHERE m.platform=? AND r.phase IN ('ack','final') AND r.state IN "
                "('pending','sending','accepted','rejected','cancelled','uncertain') GROUP BY r.phase,r.state", (p,))]
except (OSError, ValueError, sqlite3.Error):
    pass
for evidence in setup.values():
    evidence['next_step'] = ('install' if not r['installed'] else
                             'binding' if not evidence['bound'] else
                             'service' if not r['ok'] else
                             'inspect_subscription' if evidence['active_subscriptions'] is None else
                             'subscription' if not evidence['active_subscriptions'] else
                             'phone_confirmation')
r['setup'] = setup
if all(not evidence['bound'] for evidence in setup.values()):
    r['setup_stage'] = 'install' if not r['installed'] else 'binding'
else:
    r['setup_stage'] = 'service_ready' if r['ok'] else 'service_attention'
print(json.dumps(r, ensure_ascii=False))
PY
