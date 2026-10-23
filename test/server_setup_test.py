"""Targeted preflight/status checks with synthetic local state, no live service."""
import contextlib
import io
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'runtime'
RUNTIME.mkdir(exist_ok=True)
BASH = shutil.which('bash')
if not BASH and shutil.which('git'):
    candidate = Path(shutil.which('git')).parents[1] / 'bin/bash.exe'
    if candidate.is_file():
        BASH = str(candidate)


class StatusTests(unittest.TestCase):
    def status(self, prefix):
        # Run the actual embedded status program, substituting only unavailable
        # Linux service/HTTP interfaces. The database reads are real and read-only.
        source = (ROOT / 'scripts/server-status.sh').read_text(encoding='utf-8').split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
        def run(args, **_):
            if args[0] == 'systemctl':
                text = 'active'
            elif args[0] == 'loginctl':
                text = 'yes'
            else:
                text = json.dumps({'schema': 1, 'subscriptions': 1})
            return subprocess.CompletedProcess(args, 0, text, '')
        class Response(io.BytesIO):
            status = 200
        def get(url, **_):
            body = {'mode': 'live'} if url.endswith('/healthz') else {'ready': True}
            return Response(json.dumps(body).encode())
        output = io.StringIO()
        with patch.dict(os.environ, {'PREFIX': str(prefix), 'NODE': 'node'}), \
                patch('subprocess.run', side_effect=run), \
                patch('urllib.request.urlopen', side_effect=get), contextlib.redirect_stdout(output):
            exec(compile(source, 'server-status.sh', 'exec'), {})
        return json.loads(output.getvalue()), output.getvalue()

    def test_bound_service_subscription_failure_resumes_without_binding(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as tmp:
            prefix = Path(tmp)
            (prefix / '.dot-im-gateway').touch()
            (prefix / 'data').mkdir()
            config = {'port': 8788, 'mode': 'live', 'dataDir': 'data', 'allowSubscriptions': True,
                      'weixin': {'enabled': True, 'ownerId': 'synthetic-private-owner'}}
            (prefix / 'config.json').write_text(json.dumps(config))
            env = "CONTROL_PLANE_TUNNEL_ID='tunnel_complete_synthetic_id'\nCONTROL_PLANE_API_KEY='synthetic-secret'\n"
            (prefix / 'tunnel-runtime.env').write_text(env)
            database = prefix / 'data/gateway.sqlite'
            with contextlib.closing(sqlite3.connect(database)) as db, db:
                db.executescript('''
                    CREATE TABLE subscriptions(platform, active, expires, secret);
                    CREATE TABLE messages(id, platform, text, owner);
                    CREATE TABLE replies(message_id, phase, state, payload);
                ''')
                now = int(time.time() * 1000)
                db.executemany('INSERT INTO subscriptions VALUES (?,?,?,?)',
                               [('weixin', 1, now - 1, 'expired-secret'),
                                ('weixin', 0, now + 60000, 'disabled-secret'),
                                ('qq', 1, now + 60000, 'other-platform-secret')])
                db.execute('INSERT INTO messages VALUES (?,?,?,?)',
                           ('private-id', 'weixin', 'private-message-body', 'private-owner'))
                db.executemany('INSERT INTO replies VALUES (?,?,?,?)',
                               [('private-id', phase, 'accepted', 'private-reply-body') for phase in ('ack', 'final')])
            before = database.read_bytes()
            state, output = self.status(prefix)
            self.assertTrue(state['ok'])
            self.assertEqual(state['tunnel_id'], 'tunnel_complete_synthetic_id')
            self.assertEqual(state['queue'], {'schema': 1, 'subscriptions': 1})
            evidence = state['setup']['weixin']
            self.assertTrue(evidence['bound'])
            self.assertEqual(evidence['active_subscriptions'], 0)
            self.assertEqual(evidence['next_step'], 'subscription')
            self.assertEqual(evidence['replies'], [{'phase': phase, 'state': 'accepted', 'count': 1} for phase in ('ack', 'final')])
            for secret in ('synthetic-secret', 'private-owner', 'private-id', 'private-message-body', 'private-reply-body', 'other-platform-secret'):
                self.assertNotIn(secret, output)
            self.assertEqual(before, database.read_bytes())
            self.assertEqual(env, (prefix / 'tunnel-runtime.env').read_text())
            with contextlib.closing(sqlite3.connect(database)) as db, db:
                db.execute('INSERT INTO subscriptions VALUES (?,?,?,?)', ('weixin', 1, now + 60000, 'new-secret'))
            state, _ = self.status(prefix)
            self.assertEqual(state['setup']['weixin']['next_step'], 'phone_confirmation')

    def test_unknown_database_does_not_claim_missing_subscription_or_create_it(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as tmp:
            prefix = Path(tmp)
            (prefix / '.dot-im-gateway').touch()
            (prefix / 'config.json').write_text(json.dumps({'weixin': {'enabled': True, 'ownerId': 'private'}}))
            state, _ = self.status(prefix)
            self.assertIsNone(state['setup']['weixin']['active_subscriptions'])
            self.assertEqual(state['setup']['weixin']['next_step'], 'inspect_subscription')
            self.assertFalse((prefix / 'data').exists())


@unittest.skipUnless(BASH, 'Bash is needed for server preflight')
class PreflightTests(unittest.TestCase):
    def shell(self, source):
        result = subprocess.run([BASH, '-c', source], cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_existing_compatible_python_selected_without_changing_path(self):
        output = self.shell('''
            source scripts/server-preflight.sh
            python3(){ return 1; }
            python3.14(){ return 1; }
            python3.13(){ return 1; }
            python3.12(){ return 1; }
            python3.11(){ return 0; }
            before="$PATH"
            unset PYTHON
            select_python || exit 1
            [ "$PYTHON" = python3.11 ] && [ "$PATH" = "$before" ] || exit 2
            PYTHON=python3
            if select_python; then exit 3; fi
            PYTHON=python3.11
            select_python || exit 4
            echo compatible_python_selected
        ''')
        self.assertIn('compatible_python_selected', output)

    def test_build_memory_floor_with_and_without_temporary_swap(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as tmp:
            mem = Path(tmp) / 'meminfo'
            mem.write_text('MemAvailable: 800000 kB\nSwapFree: 0 kB\n')
            path = mem.as_posix()
            self.shell(f'source scripts/server-preflight.sh; if build_memory_available "{path}"; then exit 1; fi')
            mem.write_text('MemAvailable: 800000 kB\nSwapFree: 1048576 kB\n')
            self.shell(f'source scripts/server-preflight.sh; build_memory_available "{path}"')

    def test_bootstrap_checks_artifact_and_memory_before_touching_service(self):
        # Execute the complete bootstrap with local command stubs. No package
        # manager, network, systemd or real deployment is invoked.
        with tempfile.TemporaryDirectory(dir=RUNTIME) as tmp:
            base = Path(tmp)
            tools = base / 'tools'
            node_dir = tools / 'node-v24.21.0-linux-x64/bin'
            node_dir.mkdir(parents=True)
            node = Path(shutil.which('node')).as_posix()
            (node_dir / 'node').write_text(f'#!/bin/sh\nexec "{node}" "$@"\n', newline='\n')
            binary = base / 'connect'
            binary.write_text('#!/bin/sh\nexit 0\n', newline='\n')
            metadata = Path(str(binary) + '.build.json')
            commit = 'a' * 40
            record = {'sourceCommit': commit, 'executableSha256': hashlib.sha256(binary.read_bytes()).hexdigest()}
            prefix = base / 'installation'
            prefix.mkdir()
            sentinel = prefix / 'config.json'
            sentinel.write_text('old configuration')
            marker = base / 'deploy-called'
            common = f'''
                export TOOLS="{tools.as_posix()}" PREFIX="{prefix.as_posix()}" USER=synthetic
                chmod +x "$TOOLS/node-v24.21.0-linux-x64/bin/node" "{binary.as_posix()}"
                uname() {{ if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi; }}
                id() {{ echo 1000; }}
                systemctl() {{ return 0; }}
                loginctl() {{ echo yes; }}
                npm() {{ return 0; }}
                curl() {{ return 1; }}
                git() {{ if [ "$1" = rev-parse ]; then echo {commit}; fi; }}
                python3() {{
                    if [ "$1" = scripts/deploy.py ]; then echo called > "{marker.as_posix()}"; fi
                    return 0
                }}
                export PYTHON=python3
            '''
            metadata.write_text(json.dumps({**record, 'sourceCommit': 'wrong'}))
            result = subprocess.run([BASH, '-c', common + f'export CONNECT_BINARY="{binary.as_posix()}"; source scripts/server-bootstrap.sh'],
                                    cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('connect_binary_source_mismatch', result.stderr)
            self.assertFalse(marker.exists())
            self.assertEqual(sentinel.read_text(), 'old configuration')

            # No artifact and low build memory must also stop before deployment.
            result = subprocess.run([BASH, '-c', common + 'unset CONNECT_BINARY; export BUILD_MIN_MEMORY_KB=999999999999; source scripts/server-bootstrap.sh'],
                                    cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('build_memory_low', result.stderr)
            self.assertFalse(marker.exists())

            metadata.write_text(json.dumps(record))
            self.shell(common + f'export CONNECT_BINARY="{binary.as_posix()}"; source scripts/server-bootstrap.sh')
            self.assertTrue(marker.exists())
            self.assertEqual(sentinel.read_text(), 'old configuration')


if __name__ == '__main__':
    unittest.main()
