#!/usr/bin/env python3
"""Linux interactive supervisor. Secrets only in memory/anonymous pipes/child env.

No SSH provisioning, QR, subscriptions, plugin updates or systemd operations.
"""
import argparse
import getpass
import json
import os
import pathlib
import re
import secrets
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import warnings


class TestError(Exception):
    pass


def require_terminal():
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise TestError('interactive_terminal_required')


def hidden(prompt, minimum=32):
    require_terminal()
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        value = getpass.getpass(prompt)
    if not minimum <= len(value) <= 1024 or '\r' in value or '\n' in value:
        raise TestError('invalid_secret_shape')
    return value


class PrivateDirectory:
    def __init__(self, parent):
        parent = pathlib.Path(parent)
        if not parent.is_absolute() or parent.is_symlink() or not parent.is_dir():
            raise TestError('private_parent_required')
        parent = parent.resolve(strict=True)
        if parent.stat().st_uid != os.getuid() or parent.stat().st_mode & 0o077:
            raise TestError('private_parent_required')
        self.parent = parent
        self.path = pathlib.Path(tempfile.mkdtemp(prefix='qq-test-', dir=parent))
        os.chmod(self.path, 0o700)
        self.identity = (self.path.stat().st_dev, self.path.stat().st_ino)

    def cleanup(self):
        # Delete only the directory we created, never a supplied prefix/old data.
        if not self.path.exists() and not self.path.is_symlink():
            return
        if (self.path.is_symlink() or self.path.parent.resolve() != self.parent or
                self.path.resolve().parent != self.parent or
                (self.path.stat().st_dev, self.path.stat().st_ino) != self.identity):
            raise TestError('cleanup_identity_mismatch')
        shutil.rmtree(self.path)


def stop_children(children):
    for child in reversed(children):
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                continue
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=3)


def tunnel_args(binary, url):
    if not re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}/mcp', url):
        raise TestError('invalid_gateway_address')
    port = int(url.split(':')[-1].split('/')[0])
    if not 1024 <= port <= 65535:
        raise TestError('invalid_gateway_address')
    return [str(binary), 'run', '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
            '--control-plane.poll-channel', 'main', '--control-plane.max-inflight', '2',
            '--mcp.max-concurrent-requests', '1', '--mcp.server-url', url,
            '--mcp.extra-headers', 'Authorization: env:DOT_MCP_AUTH',
            '--mcp.discovery-extra-headers', 'Authorization: env:DOT_MCP_AUTH',
            '--health.listen-addr', '127.0.0.1:0', '--log.format', 'json',
            '--log.level', 'warn', '--admin-ui.log-buffer-events', '1']


def run(args):
    require_terminal()
    if sys.platform != 'linux':
        raise TestError('linux_required')
    import fcntl
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    for value in [args.app_id, args.expected_owner or '', args.tunnel_id, args.organization_id]:
        if value and not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
            raise TestError('invalid_identifier')
    if not 1 <= args.maximum_seconds <= 1800:
        raise TestError('invalid_test_duration')
    if not args.gateway_host or len(args.gateway_host) > 4 or any(
            not re.fullmatch(r'(?:[a-z0-9-]+\.)+qq\.com', h) for h in args.gateway_host):
        raise TestError('invalid_gateway_hosts')
    for binary in [args.node, args.tunnel_client]:
        if not binary.is_absolute() or not binary.is_file():
            raise TestError('absolute_binary_required')
    # Lock this isolated test area; do not stop any pre-existing test/client.
    if not args.parent.is_absolute():
        raise TestError('absolute_parent_required')
    parent = args.parent.resolve(strict=True)
    if args.parent.is_symlink() or parent.stat().st_uid != os.getuid() or parent.stat().st_mode & 0o077:
        raise TestError('private_parent_required')
    fd = os.open(parent / '.qq-test.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise TestError('test_already_running') from None
        print('QQ-only temporary test. Verify the selected bot/account. No subscriptions or autostart.')
        print('Secrets stay in process memory; do not paste them into chat or capture this terminal.')
        qq_secret = hidden('QQ application secret (hidden): ', minimum=16)
        runtime_key = hidden('Existing Tunnel Read+Use runtime key (hidden): ')
        session = PrivateDirectory(parent)
        children = []
        old_handlers = {}
        try:
            def interrupted(_signum, _frame):
                raise KeyboardInterrupt
            for name in (signal.SIGTERM, signal.SIGHUP):
                old_handlers[name] = signal.signal(name, interrupted)
            bearer = secrets.token_urlsafe(48)
            env = {'PATH': '/usr/bin:/bin', 'HOME': str(session.path), 'TMPDIR': str(session.path),
                   'XDG_CONFIG_HOME': str(session.path / 'config'), 'XDG_CACHE_HOME': str(session.path / 'cache'),
                   'GOMEMLIMIT': '100MiB', 'GOMAXPROCS': '1'}
            script = pathlib.Path(__file__).resolve().parents[1] / 'bin/qq-test-session.js'
            node = subprocess.Popen([str(args.node), '--max-old-space-size=96', str(script)],
                                    env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, start_new_session=True)
            children.append(node)
            payload = {'appId': args.app_id, 'expectedOwner': args.expected_owner,
                       'secret': qq_secret, 'bearer': bearer, 'dataDir': str(session.path / 'data'),
                       'gatewayHosts': args.gateway_host, 'maximumSeconds': args.maximum_seconds}
            node.stdin.write((json.dumps(payload) + '\n').encode()); node.stdin.flush()
            del payload, qq_secret
            deadline = time.monotonic() + args.maximum_seconds
            candidate = None
            challenge_seen = False
            confirmed = False
            started = False
            buffer = b''
            print(json.dumps({'stage': 'started', 'session_directory': str(session.path),
                              'maximum_seconds': args.maximum_seconds}), flush=True)
            while time.monotonic() < deadline:
                if any(c.poll() is not None for c in children[1:]):
                    raise TestError('child_exited')
                readable, _, _ = select.select([node.stdout, sys.stdin], [], [], min(.5, max(0, deadline-time.monotonic())))
                if sys.stdin in readable:
                    line = sys.stdin.readline(512)
                    if not line or line.strip() == 'STOP':
                        break
                    value = line.strip()
                    # Extra CR/LF after hidden input, or Enter while connecting,
                    # is neither confirmation nor rejection. Never auto-confirm.
                    if value:
                        if candidate is None:
                            print(json.dumps({'stage': 'waiting', 'reason': 'no_binding_candidate_yet'}), flush=True)
                        else:
                            if value != candidate:
                                raise TestError('operator_confirmation_rejected')
                            node.stdin.write((value + '\n').encode()); node.stdin.flush()
                            candidate = None
                            confirmed = True
                if node.stdout not in readable:
                    continue
                chunk = os.read(node.stdout.fileno(), 4096)
                if not chunk:
                    if node.poll() is not None and node.returncode != 0:
                        raise TestError('gateway_process_exited')
                    break
                buffer += chunk
                if len(buffer) > 16384:
                    raise TestError('session_output_limit')
                while b'\n' in buffer:
                    raw, buffer = buffer.split(b'\n', 1)
                    event = json.loads(raw)
                    stage = event.get('stage')
                    if stage == 'connecting':
                        print(json.dumps({'stage': 'connecting', 'platform': 'qq'}), flush=True)
                    elif stage == 'progress':
                        phase = event.get('phase')
                        if phase not in ['qq_auth_request', 'qq_auth_response', 'qq_gateway_request', 'qq_gateway_response', 'qq_wss_discovered', 'qq_wss_packet', 'qq_wss_close']:
                            raise TestError('invalid_progress')
                        safe = {'stage': 'progress', 'phase': phase}
                        for field, lower, upper in [('op', -1, 255), ('close_code', 1000, 4999)]:
                            number = event.get(field)
                            if isinstance(number, int) and lower <= number <= upper:
                                safe[field] = number
                        if event.get('event_type') in ['READY', 'RESUMED', 'C2C_MESSAGE_CREATE', 'other']:
                            safe['event_type'] = event['event_type']
                        status = event.get('http_status')
                        if isinstance(status, int) and 100 <= status <= 599:
                            safe['http_status'] = status
                        host = event.get('host', '')
                        if host == 'unapproved-host' or re.fullmatch(r'(?:[a-z0-9-]+\.)+qq\.com', host):
                            safe['host'] = host
                        print(json.dumps(safe), flush=True)
                    elif stage == 'binding_challenge':
                        value = event.get('challenge', '')
                        if challenge_seen or event.get('appId') != args.app_id or not re.fullmatch(r'DOT-BIND-[a-f0-9]{48}', value):
                            raise TestError('invalid_binding_prompt')
                        challenge_seen = True
                        print('In your intended QQ account, privately send this ONLY to your selected bot:')
                        print(value, flush=True)
                    elif stage == 'candidate':
                        owner = event.get('ownerId', '')
                        if (not challenge_seen or confirmed or event.get('appId') != args.app_id or
                                not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', owner) or
                                (args.expected_owner and owner != args.expected_owner)):
                            raise TestError('invalid_candidate')
                        candidate = f'CONFIRM {args.app_id} {owner}'
                        print('Verify the QQ account you used and the bot AppID. This proves account control, not legal identity.')
                        print('Confirm ONLY in this local terminal: ' + candidate, flush=True)
                    elif stage == 'gateway_ready':
                        if started or not confirmed:
                            raise TestError('unconfirmed_or_duplicate_gateway_start')
                        client_env = {**env, 'CONTROL_PLANE_API_KEY': runtime_key,
                                      'CONTROL_PLANE_TUNNEL_ID': args.tunnel_id,
                                      'CONTROL_PLANE_ORGANIZATION_ID': args.organization_id,
                                      'DOT_MCP_AUTH': 'Bearer ' + bearer}
                        client = subprocess.Popen(tunnel_args(args.tunnel_client, event.get('url', '')),
                                                  env=client_env, stdin=subprocess.DEVNULL,
                                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                                  start_new_session=True)
                        children.append(client); started = True
                        del client_env, runtime_key, bearer
                        print(json.dumps({'stage': 'gateway_ready', 'tools': ['gateway_status', 'list_pending', 'read_message', 'reply'],
                                          'platform': 'qq', 'subscriptions': False}), flush=True)
                    elif stage == 'failed':
                        # Only our fixed diagnostic codes, never raw error text.
                        code = event.get('code', '')
                        allowed = {'binding_timeout', 'binding_rejected', 'binding_or_start_rejected', 'session_failed',
                                   'qq_connection_failed', 'qq_token_rejected', 'qq_gateway_rejected', 'destination_denied',
                                   'non_public_destination', 'dns_timeout', 'network_before_connect', 'network_failure',
                                   'qq_websocket_connect', 'qq_websocket_rejected', 'qq_websocket_handshake',
                                   'qq_hello_timeout', 'qq_ready_timeout', 'qq_websocket_closed', 'qq_invalid_hello', 'qq_invalid_dispatch', 'qq_invalid_session',
                                   'qq_heartbeat_timeout', 'qq_socket_error'}
                        raise TestError(code if code in allowed else 'gateway_connection_failed')
                    elif stage == 'gateway_stopped':
                        raise TestError('gateway_stopped')
                    else:
                        raise TestError('unexpected_stage')
        finally:
            # Ignore repeat terminal signals while terminating owned children.
            for name in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                if name not in old_handlers:
                    old_handlers[name] = signal.getsignal(name)
                signal.signal(name, signal.SIG_IGN)
            try:
                stop_children(children)
                session.cleanup()
                print(json.dumps({'stage': 'stopped', 'processes_remaining': False, 'data_removed': True,
                                  'gateway_exit_code': children[0].returncode if children else None,
                                  'tunnel_exit_code': children[1].returncode if len(children)>1 else None}), flush=True)
            except Exception:
                print(json.dumps({'stage': 'cleanup_failed', 'session_directory': str(session.path)}), flush=True)
                raise TestError('cleanup_failed') from None
            finally:
                for name, previous in old_handlers.items():
                    signal.signal(name, previous)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('parent', 'node', 'tunnel-client'):
        parser.add_argument('--' + flag, type=pathlib.Path, required=True)
    for flag in ('app-id', 'tunnel-id', 'organization-id'):
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--gateway-host', action='append', required=True)
    parser.add_argument('--expected-owner', default='')
    parser.add_argument('--maximum-seconds', type=int, default=1800)
    args = parser.parse_args()
    try:
        run(args)
    except KeyboardInterrupt:
        pass
    except TestError as error:
        print(json.dumps({'stage': 'failed', 'code': str(error)})); return 1
    except Exception:
        # Never include exception text, secret values or external response bodies.
        print(json.dumps({'stage': 'failed', 'code': 'unexpected_failure'})); return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
