#!/usr/bin/python3
"""Owner-only host command broker; Linux Unix socket, no public HTTP listener."""
import datetime
import http.server
import json
import os
import pathlib
import re
import select
import selectors
import signal
import socket
import socketserver
import sqlite3
import stat
import struct
import subprocess
import threading
import time
import uuid

CONFIG_PATH = '/etc/openclaw/host-admin.json'
STATE_PATH = '/var/lib/community-host-admin'
MAX_BODY = 100_000
MAX_OUTPUT = 16_384  # Combined stdout and stderr, counted as bytes.
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
       'HOME': '/root', 'USER': 'root', 'LOGNAME': 'root', 'LANG': 'C.UTF-8'}


class InvalidRequest(Exception):
    pass


def valid_uuid(value):
    if not isinstance(value, str):
        return False
    try:
        parsed = uuid.UUID(value)
        return str(parsed) == value and parsed.int != 0
    except ValueError:
        return False


def load_config(path=CONFIG_PATH, owner_uid=0):
    """Read once from a regular root-owned file, rejecting symlinks/writable config."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
            raise ValueError('unsafe config ownership or permissions')
        if info.st_size > 16_384:
            raise ValueError('config too large')
        with os.fdopen(fd, 'r', encoding='utf-8', closefd=False) as source:
            data = json.load(source)
    finally:
        os.close(fd)
    if not isinstance(data, dict) or set(data) != {'user_ids', 'peer_uid', 'socket_path'}:
        raise ValueError('invalid config fields')
    ids = data['user_ids']
    if not isinstance(ids, list) or not ids or len(ids) > 100 or not all(valid_uuid(x) for x in ids):
        raise ValueError('invalid user allowlist')
    if len(set(ids)) != len(ids):
        raise ValueError('duplicate user IDs')
    peer = data['peer_uid']
    if type(peer) is not int or peer <= 0 or peer > 2**31 - 1:
        raise ValueError('invalid peer UID')
    path = data['socket_path']
    if (not isinstance(path, str) or not path.startswith('/run/') or '\x00' in path
            or len(path.encode()) > 100 or str(pathlib.PurePosixPath(path)) != path
            or '..' in pathlib.PurePosixPath(path).parts or not path.endswith('.sock')):
        raise ValueError('invalid socket path')
    return data


def parse_request(data):
    if not isinstance(data, dict) or set(data) - {'requestId', 'userId', 'roomId', 'command', 'cwd', 'timeoutMs'}:
        raise InvalidRequest('invalid_fields')
    if not all(valid_uuid(data.get(k)) for k in ('requestId', 'userId', 'roomId')):
        raise InvalidRequest('invalid_identity')
    command = data.get('command')
    if not isinstance(command, str) or not command.strip() or len(command) > 16_000 or '\x00' in command:
        raise InvalidRequest('invalid_command')
    cwd = data.get('cwd', '/')
    if not isinstance(cwd, str) or not cwd.startswith('/') or '\x00' in cwd or len(cwd) > 4096:
        raise InvalidRequest('invalid_cwd')
    timeout = data.get('timeoutMs', 30_000)
    if type(timeout) is not int or not 1000 <= timeout <= 120_000:
        raise InvalidRequest('invalid_timeout')
    return {**data, 'cwd': cwd, 'timeoutMs': timeout}


class RequestStore:
    """Permanent request ID tombstones; command strings and output never persist."""
    def __init__(self, directory=STATE_PATH, owner_uid=0):
        folder = pathlib.Path(directory)
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = folder.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o077:
            raise ValueError('unsafe state directory')
        db_path = folder / 'requests.sqlite3'
        fd = os.open(db_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o077:
                raise ValueError('unsafe state database')
        finally:
            os.close(fd)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, '
                        'user_id TEXT NOT NULL, room_id TEXT NOT NULL, status TEXT NOT NULL, '
                        'started_at REAL NOT NULL, finished_at REAL, exit_code INTEGER)')
        self.db.execute("UPDATE requests SET status='interrupted', finished_at=? WHERE status='running'", (time.time(),))
        self.db.commit()

    def claim(self, request):
        with self.lock:
            try:
                self.db.execute('INSERT INTO requests VALUES (?, ?, ?, ?, ?, NULL, NULL)',
                                (request['requestId'], request['userId'], request['roomId'], 'running', time.time()))
                self.db.commit()
                return True
            except sqlite3.IntegrityError:
                self.db.rollback()
                return False

    def finish(self, request_id, status, exit_code=None):
        with self.lock:
            self.db.execute('UPDATE requests SET status=?, finished_at=?, exit_code=? WHERE request_id=?',
                            (status, time.time(), exit_code, request_id))
            self.db.commit()

    def close(self):
        self.db.close()


def peer_uid(connection):
    # Fail closed off Linux. No trust in request headers or self-reported Unix IDs.
    if not hasattr(socket, 'SO_PEERCRED'):
        raise PermissionError('peer_credentials_unavailable')
    return struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]


def disconnected(connection):
    try:
        if not select.select([connection], [], [], 0)[0]:
            return False
        return connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b''
    except (BlockingIOError, socket.timeout):
        return False
    except OSError:
        return True


def stop_group(process):
    """Terminate ordinary descendants even if the original shell has exited."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    time.sleep(0.15)
    process.poll()  # Reap the shell before checking its remaining descendants.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def execute(request, is_disconnected=lambda: False):
    started = time.monotonic()
    deadline = started + request['timeoutMs'] / 1000
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    timed_out = cancelled = truncated = stopped = False
    # Profiles are disabled: a command does not inherit the service environment or
    # accidentally source root profile credentials. Explicit host access remains root.
    process = subprocess.Popen(['/bin/bash', '--noprofile', '--norc', '-c', request['command']],
                               cwd=request['cwd'], env=ENV.copy(), stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    drain_deadline = None
    for label, stream in (('stdout', process.stdout), ('stderr', process.stderr)):
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, label)
    try:
        while selector.get_map() or process.poll() is None:
            now = time.monotonic()
            if not stopped:
                cancelled = is_disconnected()
                timed_out = not cancelled and now >= deadline
                if cancelled or timed_out or process.poll() is not None:
                    stop_group(process)
                    stopped = True
                    drain_deadline = time.monotonic() + 1
            if drain_deadline is not None and time.monotonic() >= drain_deadline:
                break
            for key, _ in selector.select(0.05):
                chunk = os.read(key.fd, 65_536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                remaining = MAX_OUTPUT - sum(len(part) for part in output.values())
                output[key.data].extend(chunk[:remaining])
                if len(chunk) > remaining:
                    truncated = True
        process.wait(timeout=2)
    finally:
        stop_group(process)
        if process.poll() is None:
            process.wait(timeout=2)
        selector.close()
        process.stdout.close()
        process.stderr.close()
    return {'requestId': request['requestId'], 'scope': 'host-root',
            'exitCode': 124 if timed_out else process.returncode,
            'stdout': output['stdout'].decode('utf-8', errors='replace'),
            'stderr': output['stderr'].decode('utf-8', errors='replace'),
            'timedOut': timed_out, 'truncated': truncated}, cancelled


def audit(event, **metadata):
    # Caller must pass metadata only, never request objects, command or output.
    print(json.dumps({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'event': event, **metadata}, separators=(',', ':')), flush=True)


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'HostAdmin'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_args):
        pass

    def respond(self, status, result):
        payload = json.dumps(result).encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(payload)
        except OSError:
            pass
        self.close_connection = True

    def authorized_peer(self):
        try:
            allowed = peer_uid(self.connection) == self.server.config['peer_uid']
        except (OSError, ValueError):
            allowed = False
        if not allowed:
            audit('peer_denied')
            self.respond(403, {'error': 'peer_not_allowed'})
        return allowed

    def do_GET(self):
        if self.authorized_peer():
            if self.path == '/health':
                self.respond(200, {'ok': True, 'scope': 'host-root'})
            else:
                self.respond(404, {'error': 'not_found'})

    def do_POST(self):
        if not self.authorized_peer():
            return
        if self.path != '/execute':
            self.respond(404, {'error': 'not_found'})
            return
        try:
            lengths = self.headers.get_all('Content-Length', [])
            if (len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,6}', lengths[0])
                    or not 1 <= int(lengths[0]) <= MAX_BODY or self.headers.get('Transfer-Encoding')
                    or self.headers.get_content_type() != 'application/json'):
                raise InvalidRequest('invalid_body')
            body = self.rfile.read(int(lengths[0]))
            if len(body) != int(lengths[0]):
                raise InvalidRequest('incomplete_body')
            request = parse_request(json.loads(body))
        except (InvalidRequest, ValueError, UnicodeError, OSError) as error:
            self.respond(400, {'error': str(error) if isinstance(error, InvalidRequest) else 'invalid_body'})
            return
        if request['userId'] not in self.server.config['user_ids']:
            audit('actor_denied', requestId=request['requestId'], userId=request['userId'], roomId=request['roomId'])
            self.respond(403, {'error': 'actor_not_allowed'})
            return
        if not self.server.slots.acquire(blocking=False):
            self.respond(503, {'error': 'executor_busy'})
            return
        claimed = False
        started = time.monotonic()
        metadata = {key: request[key] for key in ('requestId', 'userId', 'roomId')}
        try:
            if not self.server.store.claim(request):
                self.respond(409, {'error': 'request_already_seen', 'requestId': request['requestId']})
                return
            claimed = True
            audit('started', **metadata)
            if disconnected(self.connection):
                self.server.store.finish(request['requestId'], 'cancelled')
                audit('cancelled', **metadata)
                return
            result, cancelled = execute(request, lambda: disconnected(self.connection))
            status = 'cancelled' if cancelled else 'timed_out' if result['timedOut'] else 'completed'
            self.server.store.finish(request['requestId'], status, result['exitCode'])
            audit(status, **metadata, exitCode=result['exitCode'], truncated=result['truncated'],
                  durationMs=round((time.monotonic() - started) * 1000))
            if not cancelled:
                self.respond(200, result)
        except Exception:
            if claimed:
                try:
                    self.server.store.finish(request['requestId'], 'failed')
                except Exception:
                    pass
            audit('failed', **metadata)
            self.respond(503, {'error': 'execution_unavailable', 'requestId': request['requestId']})
        finally:
            self.server.slots.release()


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, socket_path, config, store):
        self.config, self.store = config, store
        self.slots = threading.BoundedSemaphore(4)
        super().__init__(socket_path, Handler)

    def handle_error(self, _request, _address):
        # A standard traceback could expose command strings or other request data.
        audit('request_handler_failed')


def main():
    if os.geteuid() != 0 or not hasattr(socket, 'SO_PEERCRED'):
        raise SystemExit('host-admin requires Linux root and SO_PEERCRED')
    os.umask(0o077)
    config = load_config()
    store = RequestStore()
    path = pathlib.Path(config['socket_path'])
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_mode & 0o022:
        raise SystemExit('unsafe socket directory')
    try:
        existing = path.lstat()
    except FileNotFoundError:
        existing = None
    if existing is not None:
        if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != 0:
            raise SystemExit('unsafe existing socket')
        path.unlink()
    server = Server(str(path), config, store)
    os.chown(path, 0, config['peer_uid'])
    os.chmod(path, 0o660)
    audit('ready', scope='host-root')
    try:
        server.serve_forever()
    finally:
        server.server_close()
        store.close()
        path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
