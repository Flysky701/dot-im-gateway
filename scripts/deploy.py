#!/usr/bin/env python3
"""Deterministic, local-release deployment. No downloads, QR or credential operations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

def require(value, message):
    if not value:
        raise ValueError(message)

def run(*args):
    subprocess.run(args, check=True)

def safe_prefix(raw):
    p = Path(raw).expanduser().absolute()
    require(not p.is_symlink(), "prefix_symlink_denied")
    resolved = p.resolve()
    require(resolved == p and len(p.parts) >= 3 and p != Path.home(), "unsafe_prefix")
    require(re.fullmatch(r"[A-Za-z0-9_./:\\-]+", str(p)), "prefix_must_not_contain_spaces_or_shell_characters")
    return p

def manifest(source):
    files = []
    for top in ('src', 'bin', 'scripts', 'skills', 'deploy', 'docs', 'licenses', 'test'):
        for p in sorted((source / top).rglob('*')):
            require(not p.is_symlink(), 'source_symlink_denied')
            if p.is_file() and '__pycache__' not in p.parts:
                files.append(p)
    for name in ('package.json', 'package-lock.json', 'config.example.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'references.lock.json'):
        p = source / name
        require(p.is_file(), 'incomplete_release_' + name)
        files.append(p)
    return {str(p.relative_to(source)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}

def unit(prefix, node):
    return f'''[Unit]
Description=Private dot IM gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={prefix}/current
ExecStart={node} {prefix}/current/bin/gateway.js serve --config {prefix}/config.json
EnvironmentFile={prefix}/runtime.env
Restart=on-failure
RestartSec=5
TimeoutStopSec=90
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths={prefix}/data
RestrictAddressFamilies=AF_INET AF_UNIX
LockPersonality=true
LimitNOFILE=1024
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
'''

def switch(prefix, target):
    current = prefix / 'current'
    old = os.readlink(current) if current.is_symlink() else None
    require(not current.exists() or current.is_symlink(), 'current_must_be_symlink')
    tmp = prefix / '.current.next'
    require(not tmp.exists() and not tmp.is_symlink(), 'stale_switch_file')
    tmp.symlink_to(target, target_is_directory=True)
    os.replace(tmp, current)
    if old:
        (prefix / 'previous.json').write_text(json.dumps({'target': old}), encoding='utf-8')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'upgrade', 'rollback', 'uninstall'])
    parser.add_argument('--prefix', default=str(Path.home() / '.local/lib/dot-im-gateway'))
    parser.add_argument('--release', default=str(ROOT), help='Reviewed local source release, never a URL')
    parser.add_argument('--apply', action='store_true', help='Apply the displayed local filesystem/systemd plan')
    parser.add_argument('--no-systemd', action='store_true', help='Stage files only; used by isolated offline tests')
    args = parser.parse_args()
    prefix = safe_prefix(args.prefix)
    source = Path(args.release).resolve()
    node = shutil.which('node')
    require(node, 'node_24_required')
    release_manifest = manifest(source) if args.action in ('install', 'upgrade') else {}
    release_id = hashlib.sha256(json.dumps(release_manifest, sort_keys=True).encode()).hexdigest()[:16]
    plan = {'action': args.action, 'prefix': str(prefix), 'release': release_id,
            'systemd': not args.no_systemd, 'preserve_data': True, 'network': False,
            'credentials_created': False, 'automatic_start': args.action in ('upgrade', 'rollback')}
    print(json.dumps(plan, ensure_ascii=False))
    if not args.apply:
        return
    require(sys.platform.startswith('linux'), 'apply_requires_linux')
    os.umask(0o077)
    marker = prefix / '.dot-im-gateway'
    if prefix.exists():
        require(marker.is_file(), 'unmanaged_prefix')
    elif args.action == 'install':
        prefix.mkdir(parents=True, mode=0o700)
        marker.write_text('1\n', encoding='ascii')
    else:
        raise ValueError('installation_missing')
    require(not (prefix / 'data').is_symlink(), 'data_symlink_denied')
    unit_path = Path.home() / '.config/systemd/user/dot-im-gateway.service'
    if args.action in ('upgrade', 'rollback', 'uninstall') and not args.no_systemd:
        run('systemctl', '--user', 'stop', 'dot-im-gateway.service')
    if args.action in ('install', 'upgrade'):
        run(node, str(source / 'scripts/release-check.js'))
        target = prefix / 'releases' / release_id
        if not target.exists():
            target.mkdir(parents=True, mode=0o700)
            for name, digest in release_manifest.items():
                p = target / name
                p.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / name, p)
                require(hashlib.sha256(p.read_bytes()).hexdigest() == digest, 'release_hash_mismatch')
            (target / 'release-manifest.json').write_text(json.dumps(release_manifest, sort_keys=True), encoding='utf-8')
        else:
            for name, digest in release_manifest.items():
                require(hashlib.sha256((target / name).read_bytes()).hexdigest() == digest, 'existing_release_modified')
        config = prefix / 'config.json'
        if not config.exists():
            c = json.loads((source / 'config.example.json').read_text(encoding='utf-8'))
            c['dataDir'] = str(prefix / 'data')
            config.write_text(json.dumps(c, indent=2), encoding='utf-8')
        (prefix / 'data').mkdir(exist_ok=True, mode=0o700)
        already_current = (prefix / 'current').is_symlink() and (prefix / 'current').resolve() == target.resolve()
        if args.action == 'upgrade' and not already_current:
            backup_dir = prefix / 'backups' / ('before-' + release_id)
            backup_dir.parent.mkdir(exist_ok=True)
            require(not backup_dir.exists(), 'backup_exists_choose_reviewed_new_release')
            run(node, str(prefix / 'current/bin/gateway.js'), 'backup', '--config', str(config), '--to', str(backup_dir))
        if not already_current:
            switch(prefix, str(target))
        if not args.no_systemd:
            unit_path.parent.mkdir(parents=True, exist_ok=True)
            if unit_path.exists():
                require(str(prefix) in unit_path.read_text(), 'unrelated_systemd_unit_exists')
            unit_path.write_text(unit(prefix, node), encoding='utf-8')
            run('systemctl', '--user', 'daemon-reload')
            run('systemctl', '--user', 'enable', 'dot-im-gateway.service')
    elif args.action == 'rollback':
        previous = Path(json.loads((prefix / 'previous.json').read_text())['target']).resolve()
        require(previous.parent == (prefix / 'releases').resolve() and previous.is_dir(), 'invalid_previous_release')
        require(json.loads((previous / 'package.json').read_text())['version'].startswith('0.1.'), 'schema_rollback_requires_review')
        switch(prefix, str(previous))
    elif args.action == 'uninstall':
        if not args.no_systemd and unit_path.exists():
            require(str(prefix) in unit_path.read_text(), 'unrelated_systemd_unit')
            run('systemctl', '--user', 'disable', 'dot-im-gateway.service')
            unit_path.unlink()
            run('systemctl', '--user', 'daemon-reload')
        if (prefix / 'current').is_symlink():
            (prefix / 'current').unlink()
        print('Service removed; data, config, secrets, releases and backups preserved.')
    if args.action in ('upgrade', 'rollback') and not args.no_systemd:
        run('systemctl', '--user', 'start', 'dot-im-gateway.service')
        run('systemctl', '--user', 'is-active', 'dot-im-gateway.service')

if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError):
        print('Deployment stopped; inspect the last completed step. Data retained.', file=sys.stderr)
        raise
