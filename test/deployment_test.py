"""Linux isolated install/upgrade/rollback/uninstall and portable dry-run tests."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
(ROOT / 'runtime').mkdir(exist_ok=True)
spec = importlib.util.spec_from_file_location('deployment', ROOT / 'scripts/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

class DeploymentTests(unittest.TestCase):
    def invoke(self, action, prefix, *args):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/deploy.py'), action,
                                 '--prefix', str(prefix), '--no-systemd', *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_plan_is_read_only(self):
        with tempfile.TemporaryDirectory(prefix='dot-deploy-', dir=ROOT / 'runtime') as tmp:
            prefix = Path(tmp) / 'installation'
            plan = self.invoke('install', prefix)
            self.assertFalse(prefix.exists())
            self.assertFalse(json.loads(plan)['network'])

    def test_unsafe_prefix_rejected(self):
        for p in ['/', str(Path.home()), '/tmp/has space', '/tmp/with;semicolon']:
            with self.assertRaises(ValueError):
                deploy.safe_prefix(p)

    def test_release_manifest_stable_and_no_secrets(self):
        a = deploy.manifest(ROOT)
        self.assertEqual(a, deploy.manifest(ROOT))
        self.assertNotIn('config.json', a)
        self.assertTrue(all(not f.endswith('.env') for f in a))

    def test_second_prefix_never_touches_another_systemd_installation(self):
        with tempfile.TemporaryDirectory(prefix='dot-deploy-', dir=ROOT / 'runtime') as tmp:
            home = Path(tmp)
            prefix = home / 'installation'
            other = home / 'installation-other'
            unit_path = home / '.config/systemd/user/dot-im-gateway.service'
            unit_path.parent.mkdir(parents=True)
            original = deploy.unit(other, '/usr/bin/node')
            unit_path.write_text(original, encoding='utf-8')
            for action in ['install', 'upgrade', 'rollback', 'uninstall']:
                with self.subTest(action=action), patch.object(deploy.Path, 'home', return_value=home), \
                        patch.object(deploy.sys, 'platform', 'linux'), \
                        patch.object(deploy.shutil, 'which', return_value='/usr/bin/node'), \
                        patch.object(deploy.sys, 'argv', ['deploy.py', action, '--prefix', str(prefix), '--apply']), \
                        patch.object(deploy, 'run') as run:
                    with self.assertRaisesRegex(ValueError, 'unrelated_systemd_unit_exists'):
                        deploy.main()
                    run.assert_not_called()
                    self.assertFalse(prefix.exists())
                    self.assertEqual(unit_path.read_text(encoding='utf-8'), original)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux deployment only')
    def test_apply_lifecycle_preserves_data(self):
        with tempfile.TemporaryDirectory(prefix='dot-deploy-', dir=ROOT / 'runtime') as tmp:
            prefix = Path(tmp) / 'installation'
            self.invoke('install', prefix, '--apply')
            first = (prefix / 'current').resolve()
            (prefix / 'data/sentinel').write_text('retain me')
            self.invoke('install', prefix, '--apply')
            self.assertEqual((prefix / 'current').resolve(), first)
            second_source = Path(tmp) / 'source'
            shutil.copytree(first, second_source)
            package = json.loads((second_source / 'package.json').read_text())
            package['version'] = '0.1.1'
            (second_source / 'package.json').write_text(json.dumps(package))
            self.invoke('upgrade', prefix, '--release', str(second_source), '--apply')
            self.assertNotEqual((prefix / 'current').resolve(), first)
            self.invoke('upgrade', prefix, '--release', str(second_source), '--apply')
            self.invoke('rollback', prefix, '--apply')
            self.assertEqual((prefix / 'current').resolve(), first)
            self.invoke('uninstall', prefix, '--apply')
            self.assertFalse((prefix / 'current').exists())
            self.assertEqual((prefix / 'data/sentinel').read_text(), 'retain me')
            self.assertTrue((prefix / 'config.json').is_file())
            self.assertTrue(list((prefix / 'backups').iterdir()))

if __name__ == '__main__':
    unittest.main()
