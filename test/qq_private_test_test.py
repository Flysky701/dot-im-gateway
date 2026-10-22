import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('qq_private', ROOT / 'scripts/qq_private_test.py')
qq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qq)


class PrivateTest(unittest.TestCase):
    def test_non_tty_never_falls_back_to_echo(self):
        with patch.object(sys, 'stdin', io.StringIO('secret')), patch.object(qq.getpass, 'getpass') as prompt:
            with self.assertRaisesRegex(qq.TestError, 'interactive_terminal_required'):
                qq.hidden('hidden')
            prompt.assert_not_called()

    def test_tunnel_arguments_have_no_secret_and_reject_arbitrary_target(self):
        args = qq.tunnel_args(Path('/official/tunnel-client'), 'http://127.0.0.1:8788/mcp')
        self.assertIn('env:CONTROL_PLANE_API_KEY', args)
        self.assertIn('Authorization: env:DOT_MCP_AUTH', args)
        for target in ['https://evil.example/mcp', 'http://localhost:8788/mcp',
                       'http://127.0.0.1:65536/mcp', 'http://127.0.0.1:80/mcp',
                       'http://127.0.0.1:8788/mcp?secret=bad']:
            with self.assertRaises(qq.TestError):
                qq.tunnel_args(Path('/official/client'), target)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux private permission and process-group semantics')
    def test_cleanup_only_owned_directory_and_symlinks_not_followed(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp); parent.chmod(0o700)
            outside = parent / 'keep'; outside.mkdir(); (outside / 'data').write_text('keep')
            session = qq.PrivateDirectory(parent)
            (session.path / 'message').write_text('synthetic private message')
            (session.path / 'link').symlink_to(outside, target_is_directory=True)
            session.cleanup(); session.cleanup()
            self.assertFalse(session.path.exists())
            self.assertEqual((outside / 'data').read_text(), 'keep')
            swapped = qq.PrivateDirectory(parent)
            swapped.path.rmdir(); swapped.path.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(qq.TestError, 'cleanup_identity_mismatch'):
                swapped.cleanup()
            self.assertTrue((outside / 'data').is_file())

    @unittest.skipUnless(sys.platform == 'linux', 'Linux interactive supervisor integration')
    def test_supervisor_hidden_input_blank_line_confirmation_timeout_and_cleanup(self):
        # A real PTY runs the real supervisor with an inert synthetic child;
        # no QQ/OpenAI network and no actual account credentials are involved.
        import pty
        import select
        import time
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp); parent.chmod(0o700)
            fake = parent / 'fake-node'
            fake.write_text('#!' + sys.executable + '\n' + '''import json,os,pathlib,sys,time
data=json.loads(sys.stdin.readline())
root=pathlib.Path(data['dataDir']);root.mkdir()
(root/'message').write_text('synthetic message')
print(json.dumps({'stage':'connecting'}),flush=True)
time.sleep(.3)
print(json.dumps({'stage':'binding_challenge','appId':data['appId'],'challenge':'DOT-BIND-'+'a'*48}),flush=True)
print(json.dumps({'stage':'candidate','appId':data['appId'],'ownerId':'synthetic-owner'}),flush=True)
confirmation=sys.stdin.readline().strip()
if confirmation=='CONFIRM synthetic-app synthetic-owner':
    (root.parent.parent/'confirmed').write_text('yes')
time.sleep(30)
''')
            fake.chmod(0o700)
            master, slave = pty.openpty()
            args = [sys.executable, str(ROOT/'scripts/qq_private_test.py'), '--parent', str(parent),
                    '--node', str(fake), '--tunnel-client', str(fake), '--app-id', 'synthetic-app',
                    '--tunnel-id', 'synthetic-tunnel', '--organization-id', 'synthetic-org',
                    '--gateway-host', 'api.bot.qq.com', '--maximum-seconds', '2']
            proc = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave); output = b''; supplied = 0; start = time.monotonic()
            blank_sent = False; confirmed = False
            values = [b'synthetic-qq-secret-0000000000000000', b'synthetic-tunnel-key-00000000000000']
            try:
                while time.monotonic()-start < 12:
                    if select.select([master], [], [], .2)[0]:
                        try:
                            chunk = os.read(master, 4096)
                        except OSError:
                            break
                        output += chunk
                        if supplied == 0 and b'QQ application secret (hidden): ' in output:
                            os.write(master, values[0]+b'\n'); supplied = 1
                        if supplied == 1 and b'Existing Tunnel Read+Use runtime key (hidden): ' in output:
                            os.write(master, values[1]+b'\n'); supplied = 2
                        if not blank_sent and b'"stage": "connecting"' in output:
                            os.write(master, b'\n'); blank_sent = True
                        if not confirmed and b'Confirm ONLY in this local terminal: CONFIRM synthetic-app synthetic-owner' in output:
                            os.write(master, b'CONFIRM synthetic-app synthetic-owner\n'); confirmed = True
                    if proc.poll() is not None:
                        # Drain final output before asserting the cleanup receipt.
                        while select.select([master], [], [], .05)[0]:
                            try:
                                output += os.read(master, 4096)
                            except OSError:
                                break
                        break
                proc.wait(timeout=3)
            finally:
                if proc.poll() is None:
                    os.killpg(proc.pid, 9); proc.wait()
                os.close(master)
            self.assertEqual(proc.returncode, 0, output.decode(errors='replace'))
            self.assertEqual(supplied, 2)
            self.assertTrue(blank_sent)
            self.assertTrue(confirmed)
            self.assertEqual((parent/'confirmed').read_text(), 'yes')
            self.assertIn(b'"data_removed": true', output)
            self.assertFalse(list(parent.glob('qq-test-*')))
            self.assertTrue(fake.exists())
            for value in values:
                self.assertNotIn(value, output)


if __name__ == '__main__':
    unittest.main()
