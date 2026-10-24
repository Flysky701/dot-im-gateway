#!/usr/bin/env python3
"""Run on the browser's host. Capture a remote handoff capability without exposing it.

Only fixed events and the capability-free loopback landing URL go to stdout.
No credentials, raw SSH output or exception strings are logged or written to disk.
"""
import argparse
import http.server
import json
import os
import re
import shlex
import signal
import subprocess
import threading
import time
import webbrowser


# stdin EOF is an explicit cancellation channel, including when the host process
# dies. A non-PTY SSH session does not reliably send SIGHUP to its remote child.
# The wrapper never touches systemd: connector cleanup restores only its own
# uncommitted handoff, while a committed persistent service continues running.
REMOTE_SUPERVISOR = r'''
import os, signal, subprocess, sys, threading, time
p = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, start_new_session=True)
stopping = threading.Event()
def stop(*_):
    stopping.set()
for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, stop)
def watch():
    try:
        # Raw fd reads avoid a daemon holding stdin's buffered lock when the
        # connector exits normally and Python finalizes with stdin still open.
        while os.read(0, 4096):
            pass
    except OSError:
        pass
    finally:
        stop()
threading.Thread(target=watch, daemon=True).start()
deadline = None
while p.poll() is None:
    if stopping.is_set() and deadline is None:
        try:
            p.terminate()
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 90
    if deadline is not None and time.monotonic() >= deadline:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        break
    time.sleep(0.1)
sys.exit(p.wait())
'''


def emit(event, **fields):
    print(json.dumps({'event': event, **fields}), flush=True)


class Capability:
    def __init__(self, remote_port, local_port):
        self.pattern = re.compile(r'http://127\.0\.0\.1:' + str(remote_port) + r'/#([a-f0-9]{64})')
        self.local_port = local_port
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.url = None
        self.consumed = False
        self.closed = False

    def accept(self, line):
        match = self.pattern.fullmatch(line.strip())
        if not match:
            return
        with self.lock:
            if not self.closed and not self.consumed and self.url is None:
                self.url = f'http://127.0.0.1:{self.local_port}/#' + match[1]
                self.ready.set()

    def take(self):
        with self.lock:
            value = self.url
            if value:
                self.consumed = True
                self.url = None
            return value

    def clear(self):
        with self.lock:
            self.url = None
            self.closed = True


def redirect_server(capability, port=0):
    class Redirect(http.server.BaseHTTPRequestHandler):
        # Use fixed responses: BaseHTTPRequestHandler.send_error would echo paths.
        def reply(self, status, location=None):
            self.send_response(status)
            self.send_header('Content-Length', '0')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            if location:
                self.send_header('Location', location)
            self.end_headers()

        def do_GET(self):
            # Only direct same-host navigation; health checks never consume it.
            expected = f'127.0.0.1:{self.server.server_port}'
            if (self.headers.get('Host') != expected or self.headers.get('Origin')
                    or self.headers.get('Referer')
                    or self.headers.get('Sec-Fetch-Site', 'none') not in ('none', 'same-origin')):
                self.reply(403)
            elif self.path == '/healthz':
                self.reply(204)
            elif self.path == '/':
                value = capability.take()
                try:
                    self.reply(302 if value else 410, value)
                finally:
                    value = None
            else:
                self.reply(404)

        def log_message(self, *_):
            pass

    class Server(http.server.HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(2)
            return connection, address

        def handle_error(self, *_):
            # Socket failures must not emit tracebacks containing request context.
            pass

    server = Server(('127.0.0.1', port), Redirect)
    server.timeout = 0.2
    return server


def capture(stream, capability):
    # Discard everything except the exact capability line, including raw JSON.
    # Bound reads so a malformed remote line cannot grow memory without limit.
    try:
        while True:
            line = stream.readline(4096)
            if not line:
                break
            if len(line) < 4096:
                capability.accept(line)
            else:
                while line and not line.endswith('\n'):
                    line = stream.readline(4096)
            line = None
    except (OSError, ValueError):
        pass


def ssh_command(args):
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@:-]*', args.host):
        raise ValueError('invalid_host')
    for value in (args.connect_binary, args.prefix):
        if not re.fullmatch(r'/[A-Za-z0-9_./-]+', value):
            raise ValueError('invalid_remote_path')
    if not re.fullmatch(r'[A-Za-z0-9_/.-]+', args.remote_python):
        raise ValueError('invalid_python')
    remote = shlex.join([args.remote_python, '-c', REMOTE_SUPERVISOR,
                         args.connect_binary, '--handoff', args.prefix,
                         '--port', str(args.remote_port), '--no-browser'])
    command = [args.ssh, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15',
               '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']
    if args.identity:
        command += ['-i', args.identity]
    if args.known_hosts:
        command += ['-o', 'UserKnownHostsFile=' + args.known_hosts]
    return command + ['-L', f'127.0.0.1:{args.local_port}:127.0.0.1:{args.remote_port}',
                      args.host, remote]


def close_process(child):
    if child is None:
        return
    # Closing stdin asks the remote supervisor to stop gracefully. Wait longer
    # than connector/systemd rollback before terminating a stuck SSH client.
    if child.stdin:
        try:
            child.stdin.close()
        except OSError:
            pass
    try:
        child.wait(timeout=100)
    except subprocess.TimeoutExpired:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
    if child.stdout:
        child.stdout.close()


def launch(args, *, popen=subprocess.Popen, open_browser=webbrowser.open, stop=None):
    stop = stop or threading.Event()
    capability = Capability(args.remote_port, args.local_port)
    server = child = reader = None
    try:
        # Bind landing port before starting SSH: a conflict cannot orphan SSH.
        server = redirect_server(capability, args.redirect_port)
        command = ssh_command(args)
        child = popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                      stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace',
                      creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        reader = threading.Thread(target=capture, args=(child.stdout, capability), daemon=True)
        reader.start()
        started = time.monotonic()
        announced = False
        while child.poll() is None and not stop.is_set():
            elapsed = time.monotonic() - started
            if elapsed > args.session_timeout:
                emit('session_timeout')
                return 1
            if not capability.ready.is_set() and elapsed > args.ready_timeout:
                emit('connection_page_timeout')
                return 1
            if capability.ready.is_set() and not announced:
                announced = True
                url = f'http://127.0.0.1:{server.server_port}/'
                emit('connection_page_ready', url=url)
                if not args.no_browser and not open_browser(url):
                    emit('browser_open_required')
            server.handle_request()
        if stop.is_set():
            emit('cancelled')
            return 130
        emit('ssh_session_ended', success=child.returncode == 0)
        return 0 if announced and child.returncode == 0 else 1
    except (OSError, ValueError, subprocess.SubprocessError):
        emit('launcher_failed')
        return 1
    finally:
        capability.clear()
        if server:
            server.server_close()
        close_process(child)
        if reader:
            reader.join(timeout=2)


def port(raw):
    value = int(raw)
    if not 1024 <= value <= 65535:
        raise argparse.ArgumentTypeError('port must be 1024..65535')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--connect-binary', required=True)
    parser.add_argument('--prefix', required=True)
    parser.add_argument('--ssh', default='ssh')
    parser.add_argument('--identity')
    parser.add_argument('--known-hosts')
    parser.add_argument('--remote-python', default='python3')
    parser.add_argument('--local-port', type=port, default=8789)
    parser.add_argument('--remote-port', type=port, default=8789)
    parser.add_argument('--redirect-port', type=port, default=0)
    parser.add_argument('--ready-timeout', type=float, default=45)
    parser.add_argument('--session-timeout', type=float, default=1800)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    return launch(args, stop=stop)


if __name__ == '__main__':
    raise SystemExit(main())
