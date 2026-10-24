"""Offline launcher tests: real loopback HTTP and child processes, no SSH account."""
import contextlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import unittest
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('launcher', ROOT / 'scripts/launch-handoff.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
TOKEN = 'a' * 64
SECRET = 'synthetic-do-not-log-key'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def request(port, path='/', headers=None):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
    try:
        c.request('GET', path, headers=headers or {})
        r = c.getresponse()
        body = r.read()
        return r.status, dict(r.getheaders()), body
    finally:
        c.close()


class LauncherTests(unittest.TestCase):
    def args(self, **changes):
        result = dict(host='test-alias', connect_binary='/home/dot/tools/connect',
                      prefix='/home/dot/service', ssh='ssh', identity=None, known_hosts=None,
                      remote_python='python3', local_port=free_port(), remote_port=8789,
                      redirect_port=free_port(), no_browser=False, ready_timeout=3, session_timeout=6)
        result.update(changes)
        return SimpleNamespace(**result)

    def test_exact_capability_single_consumption_and_clear(self):
        cap = launcher.Capability(8789, 8799)
        for line in ('http://evil.invalid:8789/#' + TOKEN, 'http://127.0.0.1:8788/#' + TOKEN,
                     '{"key":"' + SECRET + '"}', 'http://127.0.0.1:8789/#short'):
            cap.accept(line)
        self.assertFalse(cap.ready.is_set())
        cap.accept('http://127.0.0.1:8789/#' + TOKEN)
        self.assertEqual(cap.take(), 'http://127.0.0.1:8799/#' + TOKEN)
        self.assertIsNone(cap.url)
        cap.accept('http://127.0.0.1:8789/#' + TOKEN)
        self.assertIsNone(cap.take())
        cap.clear()
        cap.accept('http://127.0.0.1:8789/#' + TOKEN)
        self.assertIsNone(cap.url)

    def test_redirect_health_origin_and_one_shot(self):
        cap = launcher.Capability(8789, 8799)
        cap.accept('http://127.0.0.1:8789/#' + TOKEN)
        server = launcher.redirect_server(cap)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            p = server.server_port
            self.assertEqual(request(p, '/healthz')[0], 204)
            self.assertEqual(request(p, headers={'Host': 'elsewhere.invalid'})[0], 403)
            self.assertEqual(request(p, headers={'Origin': 'https://elsewhere.invalid'})[0], 403)
            status, headers, body = request(p)
            self.assertEqual(status, 302)
            self.assertEqual(headers['Location'], 'http://127.0.0.1:8799/#' + TOKEN)
            self.assertEqual(headers['Cache-Control'], 'no-store')
            self.assertEqual(body, b'')
            self.assertIsNone(cap.url)
            self.assertEqual(request(p)[0], 410)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    def run_child(self, *, ready=True, browser_error=False, timeout=False, natural_exit=False):
        args = self.args(ready_timeout=0.3 if not ready else 3,
                         session_timeout=0.5 if timeout else 6)
        stopped = threading.Event()
        children, commands = [], []
        # This local stand-in really holds the forwarded port and waits for EOF.
        # Its raw JSON deliberately contains a secret: the launcher must discard it.
        source = ('import socket,sys\n'
                  's=socket.socket();s.bind(("127.0.0.1",int(sys.argv[1])));s.listen()\n'
                  f'print({json.dumps(json.dumps({"key": SECRET}))},flush=True)\n')
        if ready:
            source += f'print("http://127.0.0.1:8789/#{TOKEN}",flush=True)\n'
        source += 'sys.stdin.buffer.read()\ns.close()\n'

        def spawn(command, **kwargs):
            commands.append(command)
            child = subprocess.Popen([sys.executable, '-u', '-c', source, str(args.local_port)], **kwargs)
            children.append(child)
            return child

        def browser(url):
            self.assertNotIn(TOKEN, url)
            self.assertEqual(request(args.redirect_port, '/healthz')[0], 204)
            if browser_error:
                raise OSError(SECRET)
            self.assertEqual(request_in_thread(url), 302)
            if natural_exit:
                children[0].stdin.close()
            elif not timeout:
                stopped.set()
            return True

        # launch's HTTP loop and browser-opening callback run on the same thread.
        # Browser is asynchronous in production; mimic that behavior here.
        browser_threads, browser_errors = [], []
        def request_in_thread(url):
            return request(args.redirect_port)[0]
        def open_browser(url):
            if browser_error:
                raise OSError(SECRET)
            def work():
                try:
                    browser(url)
                except BaseException as error:
                    browser_errors.append(error)
                    stopped.set()
            thread = threading.Thread(target=work)
            browser_threads.append(thread)
            thread.start()
            return True

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = launcher.launch(args, popen=spawn, open_browser=open_browser, stop=stopped)
        for thread in browser_threads:
            thread.join(3)
        self.assertFalse(browser_errors, browser_errors)
        self.assertTrue(all(p.poll() is not None for p in children))
        for p in (args.redirect_port, args.local_port):
            with socket.socket() as probe:
                probe.settimeout(1)
                self.assertNotEqual(probe.connect_ex(('127.0.0.1', p)), 0)
            with socket.socket() as s:
                # POSIX can retain closed HTTP connections in TIME_WAIT. Reuse
                # that address, but still require the listener above to be gone.
                if os.name == 'posix':
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(('127.0.0.1', p))
        self.assertNotIn(TOKEN, output.getvalue())
        self.assertNotIn(SECRET, output.getvalue())
        self.assertNotIn(TOKEN, str(commands))
        self.assertIn('StrictHostKeyChecking=yes', commands[0])
        return code, output.getvalue()

    def test_cancel_releases_ssh_and_both_ports_without_secret_output(self):
        code, output = self.run_child()
        self.assertEqual(code, 130)
        self.assertIn('cancelled', output)

    def test_browser_failure_releases_process_and_ports(self):
        code, output = self.run_child(browser_error=True)
        self.assertEqual(code, 1)
        self.assertIn('launcher_failed', output)

    def test_missing_capability_times_out_and_cleans_up(self):
        code, output = self.run_child(ready=False)
        self.assertEqual(code, 1)
        self.assertIn('connection_page_timeout', output)

    def test_session_timeout_after_consumption_cleans_up(self):
        code, output = self.run_child(timeout=True)
        self.assertEqual(code, 1)
        self.assertIn('session_timeout', output)

    def test_natural_exit_cleans_up(self):
        code, output = self.run_child(natural_exit=True)
        self.assertEqual(code, 0)
        self.assertIn('ssh_session_ended', output)

    def test_occupied_redirect_port_never_starts_ssh(self):
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', 0))
            occupied.listen()
            args = self.args(redirect_port=occupied.getsockname()[1])
            def forbidden(*_, **__):
                self.fail('SSH must not start')
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(launcher.launch(args, popen=forbidden), 1)

    @unittest.skipUnless(os.name == 'posix', 'Remote supervisor requires POSIX server')
    def test_remote_supervisor_stdin_eof_stops_connector(self):
        child = subprocess.Popen([sys.executable, '-c', launcher.REMOTE_SUPERVISOR,
                                  sys.executable, '-u', '-c',
                                  'import time; print("ready", flush=True); time.sleep(60)'],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(), b'ready\n')
            child.stdin.close()
            child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()
            child.stdout.close()


if __name__ == '__main__':
    unittest.main()
