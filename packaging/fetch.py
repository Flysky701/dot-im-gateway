"""Build-time only: fixed official binary, checksum, and bundled license material."""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
LOCK = {
    'win32': ('windows-amd64', 'b89074637596262067061308cf174959561a1a8bcffe2db956650dad7303052b', '7fa05f02e1187d6bb5df44133cc02669f42c8d11a0c3ea818780d86c5ed66235'),
    'linux': ('linux-amd64', 'bd6a57c6c0511644267cafadd13ffdb53ece0d753e0b88857f957e78a8fbc793', '22bdf95290d3b39d0274a608b5347c9b343b3f4147be5106db76ff677e2814be'),
}

def download(url, target, digest=None):
    if not target.exists():
        request = urllib.request.Request(url, headers={'User-Agent': 'dot-im-gateway-build'})
        with urllib.request.urlopen(request, timeout=90) as response:
            data = response.read(150 * 1024 * 1024)
        if digest and hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('official_asset_hash_mismatch')
        target.write_bytes(data)
    if digest and hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        raise ValueError('cached_asset_hash_mismatch')

def main():
    platform = sys.argv[1] if len(sys.argv) > 1 else sys.platform
    name, archive_hash, licenses_hash = LOCK[platform]
    dest = ROOT / 'cache' / platform
    dest.mkdir(parents=True, exist_ok=True)
    base = 'https://github.com/openai/tunnel-client/releases/download/v0.0.17/'
    archive = dest / 'tunnel.zip'
    download(base + 'tunnel-client-v0.0.17-' + name + '.zip', archive, archive_hash)
    download(base + 'tunnel-client-v0.0.17-' + name + '-licenses.txt', dest / 'tunnel-dependencies.txt', licenses_hash)
    binary = 'tunnel-client.exe' if platform == 'win32' else 'tunnel-client'
    with zipfile.ZipFile(archive) as z:
        matches = [n for n in z.namelist() if Path(n).name == binary]
        if len(matches) != 1:
            raise ValueError('unexpected_official_archive')
        (dest / binary).write_bytes(z.read(matches[0]))
    (dest / binary).chmod(0o700)
    for repo, ref, file, target in [
        ('openai/tunnel-client', 'v0.0.17', 'LICENSE', 'tunnel-LICENSE'),
        ('openai/tunnel-client', 'v0.0.17', 'NOTICE', 'tunnel-NOTICE'),
        ('nodejs/node', 'v24.21.0', 'LICENSE', 'node-LICENSE')]:
        download('https://raw.githubusercontent.com/' + repo + '/' + ref + '/' + file, dest / target)
    print(json.dumps({'platform': platform, 'official_archive_sha256': archive_hash, 'binary_sha256': hashlib.sha256((dest / binary).read_bytes()).hexdigest()}))

if __name__ == '__main__':
    main()
