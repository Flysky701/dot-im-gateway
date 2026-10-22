import importlib.util,io,pathlib,sys,unittest,os,subprocess,tempfile,time
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import weixin_private_test as w
class WeixinPrivateTest(unittest.TestCase):
    def test_qr_is_rendered_locally_without_network_or_image_dependencies(self):
        output=io.StringIO();w.render_qr('synthetic-weixin-qr-not-a-real-login',output)
        self.assertGreater(len(output.getvalue()),100)
        self.assertNotIn('synthetic-weixin',output.getvalue())
    def test_non_tty_rejected_before_credentials_or_network(self):
        with patch.object(sys,'stdin',io.StringIO()):
            with self.assertRaises(w.TestError):w.require_terminal()
    def test_renderer_input_bound(self):
        for text in ['',None,'x'*2049]:
            with self.assertRaises(w.TestError):w.render_qr(text,io.StringIO())
    @unittest.skipUnless(sys.platform=='linux','Linux PTY and cleanup')
    def test_hidden_phone_code_and_timeout_cleanup(self):
        import pty,select
        with tempfile.TemporaryDirectory() as tmp:
            parent=pathlib.Path(tmp);parent.chmod(0o700);fake=parent/'fake-node'
            fake.write_text('#!'+sys.executable+'\n'+'''import json,pathlib,sys,time
data=json.loads(sys.stdin.readline());root=pathlib.Path(data['dataDir']);root.mkdir()
print(json.dumps({'stage':'qr','content':'synthetic-qr-no-real-login'}),flush=True)
print(json.dumps({'stage':'verify_code_required'}),flush=True)
if sys.stdin.readline().strip()=='876543':(root.parent.parent/'verified').write_text('yes')
print(json.dumps({'stage':'owner_bound','source':'official_confirmed'}),flush=True)
time.sleep(30)
''');fake.chmod(0o700)
            master,slave=pty.openpty()
            proc=subprocess.Popen([sys.executable,str(ROOT/'scripts/weixin_private_test.py'),'--parent',str(parent),'--node',str(fake),'--tunnel-client',str(fake),'--tunnel-id','synthetic','--organization-id','synthetic','--maximum-seconds','2'],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
            os.close(slave);output=b'';key_sent=False;code_sent=False;start=time.monotonic()
            try:
                while time.monotonic()-start<10:
                    if select.select([master],[],[],.2)[0]:
                        try:output+=os.read(master,4096)
                        except OSError:break
                        if not key_sent and b'runtime key (hidden):' in output:
                            os.write(master,b'synthetic-runtime-key-000000000000000000\n');key_sent=True
                        if not code_sent and b'digits shown by your phone (hidden):' in output:
                            os.write(master,b'876543\n');code_sent=True
                proc.wait(timeout=3)
            finally:
                if proc.poll() is None:os.killpg(proc.pid,9);proc.wait()
                os.close(master)
            self.assertEqual(proc.returncode,0,output.decode(errors='replace'));self.assertTrue(code_sent)
            self.assertEqual((parent/'verified').read_text(),'yes');self.assertIn(b'"data_removed": true',output)
            self.assertNotIn(b'876543',output);self.assertNotIn(b'synthetic-runtime-key',output)
            self.assertFalse(list(parent.glob('qq-test-*')))
if __name__=='__main__':unittest.main()
