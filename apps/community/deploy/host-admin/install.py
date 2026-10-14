#!/usr/bin/python3
"""Explicit, one-time installation for the existing deployment's sole administrator."""
import importlib.machinery
import importlib.util
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

HERE = Path(__file__).resolve().parent
SOCKET = '/run/community-admin/admin.sock'
LOCK = '/run/lock/openclaw-deploy.lock'
SERVICE = 'community-host-admin.service'


def mapping_block(lines, key, indent):
    starts = [i for i, line in enumerate(lines) if re.match(r'^' + ' ' * indent + re.escape(key) + r':', line)]
    if len(starts) != 1 or lines[starts[0]].rstrip() != ' ' * indent + key + ':':
        raise ValueError('Expected one block mapping: ' + key)
    start = starts[0]
    end = next((i for i in range(start + 1, len(lines)) if lines[i].strip()
                and not lines[i].lstrip().startswith('#')
                and len(lines[i]) - len(lines[i].lstrip(' ')) <= indent), len(lines))
    return start, end


def patch_manifest(source, owner_id):
    if (not isinstance(owner_id, str) or owner_id == '00000000-0000-0000-0000-000000000000'
            or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', owner_id)):
        raise ValueError('Invalid owner ID')
    if not isinstance(source, str) or '\t' in source:
        raise ValueError('Expected space-indented manifest')
    lines = source.splitlines(keepends=True)
    service_start, service_end = mapping_block(lines, 'services', 0)
    start, end = mapping_block(lines[service_start + 1:service_end], 'app', 2)
    start += service_start + 1
    end += service_start + 1
    app = lines[start:end]
    env_start, env_end = mapping_block(app, 'environment', 4)
    mapping_block(app, 'volumes', 4)
    names = []
    for line in app[env_start + 1:env_end]:
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.match(r'^      ([A-Za-z_][A-Za-z0-9_]*):(?:\s|$)', line)
        if not match:
            raise ValueError('Expected simple environment mapping')
        names.append(match[1])
    if len(names) != len(set(names)):
        raise ValueError('Duplicate environment configuration')
    values = {'COMMUNITY_HOST_ADMIN_SOCKET': SOCKET, 'COMMUNITY_HOST_ADMIN_USER_IDS': owner_id,
              'COMMUNITY_OPENCLAW_TIMEOUT_MS': '180000'}
    for name, value in values.items():
        env_start, env_end = mapping_block(app, 'environment', 4)
        existing = [i for i in range(env_start + 1, env_end) if re.match(r'^      ' + name + r':', app[i])]
        if len(existing) > 1:
            raise ValueError('Duplicate admin configuration')
        entry = "      " + name + ": '" + value + "'\n"
        if existing:
            app[existing[0]] = entry
        else:
            position = [i for i, line in enumerate(app) if line.rstrip() == '    environment:']
            if len(position) != 1:
                raise ValueError('Expected environment mapping')
            app.insert(position[0] + 1, entry)
    volume_start, volume_end = mapping_block(app, 'volumes', 4)
    mounts = []
    for line in app[volume_start + 1:volume_end]:
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if not re.match(r'^      - \S', line):
            raise ValueError('Expected simple volume list')
        if '/run/community-admin' in line:
            mounts.append(line.strip())
    if not mounts:
        app.insert(volume_start + 1, '      - /run/community-admin:/run/community-admin:ro,z\n')
    elif mounts != ['- /run/community-admin:/run/community-admin:ro,z']:
        raise ValueError('Unexpected admin mount')
    return ''.join(lines[:start] + app + lines[end:])


def write_root(path, content, mode=0o600):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('Refusing symlink')
    temporary = path.with_name(path.name + '.install-pending')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(content.encode() if isinstance(content, str) else content)
            file.flush()
            os.fsync(file.fileno())
        os.chown(temporary, 0, 0)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def unit_state():
    values = []
    for option, allowed in [('is-enabled', {'enabled', 'disabled', 'not-found'}),
                            ('is-active', {'active', 'inactive', 'unknown'})]:
        result = subprocess.run(['systemctl', option, SERVICE], capture_output=True, text=True, timeout=10)
        value = result.stdout.strip()
        if option == 'is-enabled' and not value and result.returncode == 4:
            value = 'not-found'
        if value not in allowed:
            raise RuntimeError('Unsupported existing service state: ' + option)
        values.append(value)
    return {'enabled': values[0] == 'enabled', 'active': values[1] == 'active'}


def verify_app_uid(run, app):
    identity = json.loads(run('docker', 'exec', app, 'node', '-p',
                             'JSON.stringify({uid:process.getuid(),groups:process.getgroups()})'))
    if identity.get('uid') != 1000 or 1000 not in identity.get('groups', []):
        raise RuntimeError('Application must run as UID 1000 with group 1000')
    pid = run('docker', 'inspect', app, '--format', '{{.State.Pid}}').strip()
    if not re.fullmatch(r'[1-9][0-9]*', pid):
        raise RuntimeError('Application host PID unavailable')
    for kind in ('uid', 'gid'):
        mapped = []
        for line in Path('/proc/' + pid + '/' + kind + '_map').read_text().splitlines():
            inside, outside, count = map(int, line.split())
            if inside <= 1000 < inside + count:
                mapped.append(outside + 1000 - inside)
        if mapped != [1000]:
            raise RuntimeError('Application UID/GID is remapped on the host')


def restore(backup, paths, modes, previous_state, compose, run, service_touched, app_touched):
    errors = []
    def attempt(function, *args, **kwargs):
        try:
            function(*args, **kwargs)
        except Exception:
            errors.append(True)
    if service_touched:
        attempt(run, 'systemctl', 'stop', SERVICE)
        attempt(run, 'systemctl', 'disable', SERVICE)
    for path in paths:
        previous = backup / path.name
        if previous.exists():
            attempt(write_root, path, previous.read_bytes(), modes[path])
        else:
            attempt(path.unlink, missing_ok=True)
    attempt(run, 'systemctl', 'daemon-reload')
    if service_touched and previous_state['enabled']:
        attempt(run, 'systemctl', 'enable', SERVICE)
    if service_touched and previous_state['active']:
        attempt(run, 'systemctl', 'start', SERVICE)
    if app_touched:
        attempt(run, *compose, 'up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '120', 'app')
    if errors:
        raise RuntimeError('Rollback incomplete; restore the saved private installation backup')


def install_locked():
    loader = importlib.machinery.SourceFileLoader('release', '/usr/local/sbin/openclaw-release')
    spec = importlib.util.spec_from_loader(loader.name, loader)
    release = importlib.util.module_from_spec(spec)
    loader.exec_module(release)
    config = release.load_config()
    app = config['compose_project'] + '-app-1'
    def run(*args):
        result = subprocess.run(args, capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise RuntimeError('Host installation step failed: ' + args[0])
        return result.stdout
    # Never enable every role=admin implicitly. Pin the one existing owner's UUID.
    verify_app_uid(run, app)
    query = "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync('/data/community.sqlite',{readOnly:true});console.log(JSON.stringify(d.prepare(\"SELECT id FROM users WHERE role='admin' ORDER BY created_at\").all()));d.close();"
    owners = json.loads(run('docker', 'exec', app, 'node', '--input-type=module', '-e', query))
    if len(owners) != 1:
        raise RuntimeError('Expected one administrator; explicitly select an owner before installing')
    owner_id = owners[0]['id']
    run('docker', 'exec', app, 'test', '-f', '/app/apps/community/host-admin.mjs')
    manifest = Path('/etc/openclaw/compose.yml')
    original = release.read_root_file(manifest)
    updated = patch_manifest(original.decode(), owner_id)
    previous_state = unit_state()
    library = Path('/usr/local/lib/community-host-admin')
    paths = [manifest, Path('/etc/openclaw/host-admin.json'), Path('/etc/systemd/system/community-host-admin.service'), library / 'service.py']
    modes = {}
    for path in paths:
        if path.is_symlink():
            raise ValueError('Unsafe installation target')
        if path.exists():
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('Unsafe installation target')
            modes[path] = stat.S_IMODE(info.st_mode)
    state = Path('/var/lib/community-host-admin')
    state.mkdir(mode=0o700, exist_ok=True)
    if state.is_symlink() or state.stat().st_uid != 0 or state.stat().st_mode & 0o077:
        raise ValueError('Unsafe state directory')
    backup = state / ('install-backup-' + str(time.time_ns()))
    backup.mkdir(parents=True, mode=0o700)
    for path in paths:
        if path.exists():
            write_root(backup / path.name, path.read_bytes())
    write_root(backup / 'metadata.json', json.dumps({'service': previous_state,
               'files': {str(path): modes.get(path) for path in paths}}, indent=2))
    if library.is_symlink() or (library.exists() and (not library.is_dir()
            or library.stat().st_uid != 0 or library.stat().st_mode & 0o022)):
        raise ValueError('Unsafe library path')
    directory = Path(config['checkout_root']) / 'apps/community/deploy'
    compose = ['docker', 'compose', '--project-directory', str(directory), '--env-file', str(directory / '.env.production'),
               '-f', str(manifest), '-p', config['compose_project']]
    service_touched = app_touched = False
    try:
        library.mkdir(mode=0o755, exist_ok=True)
        os.chown(library, 0, 0)
        os.chmod(library, 0o755)
        write_root(library / 'service.py', (HERE / 'service.py').read_bytes(), 0o755)
        write_root(paths[1], json.dumps({'user_ids':[owner_id], 'peer_uid':1000, 'socket_path':SOCKET}))
        write_root(paths[2], (HERE / 'community-host-admin.service').read_bytes(), 0o644)
        write_root(manifest, updated)
        run(*compose, 'config', '--quiet')
        run('systemctl', 'daemon-reload')
        service_touched = True
        run('systemctl', 'enable', 'community-host-admin.service')
        run('systemctl', 'restart', 'community-host-admin.service')
        for _ in range(40):
            if Path(SOCKET).is_socket():
                break
            time.sleep(.25)
        else:
            raise RuntimeError('Host broker did not start')
        app_touched = True
        run(*compose, 'up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '120', 'app')
        verify_app_uid(run, app)
        # Verify both real root execution and refusal of a non-owner, through app UID1000.
        smoke = """import {request} from 'node:http';import {randomUUID} from 'node:crypto';
const socketPath=process.env.COMMUNITY_HOST_ADMIN_SOCKET,userId=process.env.COMMUNITY_HOST_ADMIN_USER_IDS;
async function call(id){return new Promise((resolve,reject)=>{const body=JSON.stringify({requestId:randomUUID(),userId:id,roomId:randomUUID(),command:'id -u',timeoutMs:3000});const q=request({socketPath,path:'/execute',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,data:JSON.parse(b)}));});q.on('error',reject);q.setTimeout(5000,()=>q.destroy(new Error('deadline')));q.end(body);});}
const good=await call(userId),bad=await call(randomUUID());if(good.status!==200||good.data.stdout.trim()!=='0'||good.data.exitCode!==0||bad.status!==403)process.exit(1);console.log('Host root execution and non-owner rejection verified.');"""
        print(run('docker', 'exec', app, 'node', '--input-type=module', '-e', smoke).strip())
        print('Owner-only administration enabled for all owner sessions; backup: ' + str(backup))
    except BaseException:
        restore(backup, paths, modes, previous_state, compose, run, service_touched, app_touched)
        raise


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run through the authorized host administrator account')
    os.umask(0o077)
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Unsafe deployment lock')
        fcntl.flock(fd, fcntl.LOCK_EX)
        install_locked()
    finally:
        os.close(fd)


if __name__ == '__main__':
    main()
