"""Run as an ordinary user: python3 -m unittest discover -s <this directory> -v."""
import contextlib
import http.client
import importlib.util
import json
import os
import pathlib
import shlex
import socket
import sys
import tempfile
import threading
import time
import unittest
import uuid
from unittest import mock

spec = importlib.util.spec_from_file_location('host_admin_service', pathlib.Path(__file__).with_name('service.py'))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
OWNER, ROOM = str(uuid.uuid4()), str(uuid.uuid4())


def request(command='printf hello', **changes):
    return service.parse_request({'requestId': str(uuid.uuid4()), 'userId': OWNER, 'roomId': ROOM,
                                  'command': command, **changes})


def python_command(code):
    return shlex.quote(sys.executable) + ' -c ' + shlex.quote(code)


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=5)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(5)
        self.sock.connect(self.path)


class ConfigTests(unittest.TestCase):
    def test_root_owned_configuration_and_rejected_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'config.json'
            data = {'user_ids': [OWNER], 'peer_uid': 1000, 'socket_path': '/run/community-admin/admin.sock'}
            path.write_text(json.dumps(data))
            path.chmod(0o600)
            self.assertEqual(service.load_config(path, os.geteuid()), data)
            path.chmod(0o666)
            with self.assertRaises(ValueError):
                service.load_config(path, os.geteuid())
            path.chmod(0o600)
            with self.assertRaises(ValueError):
                service.load_config(path, os.geteuid() + 1)
            link = pathlib.Path(folder) / 'symlink.json'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                service.load_config(link, os.geteuid())

    def test_invalid_allowlist_and_socket_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'config.json'
            for changes in ({'user_ids': []}, {'user_ids': ['owner']}, {'peer_uid': True},
                            {'socket_path': '/tmp/public.sock'}, {'socket_path': '/run/../tmp/a.sock'},
                            {'extra': True}):
                path.write_text(json.dumps({'user_ids': [OWNER], 'peer_uid': 1000,
                                            'socket_path': '/run/community-admin/admin.sock', **changes}))
                path.chmod(0o600)
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    service.load_config(path, os.geteuid())

    def test_request_validation(self):
        for changes in ({'userId': None}, {'roomId': 'shared'}, {'requestId': 'no'},
                        {'command': ''}, {'command': 'a' * 16_001}, {'command': 'a\0b'},
                        {'cwd': '../'}, {'timeoutMs': True}, {'timeoutMs': 999},
                        {'timeoutMs': 120_001}, {'unexpected': 1}):
            with self.subTest(changes=changes), self.assertRaises(service.InvalidRequest):
                request(**changes)
        self.assertEqual(request()['cwd'], '/')
        self.assertEqual(request()['timeoutMs'], 30_000)


class ExecutionTests(unittest.TestCase):
    def test_exit_stdout_stderr_and_no_inherited_environment(self):
        with mock.patch.dict(os.environ, {'HOST_ADMIN_TEST_SECRET': 'DO-NOT-INHERIT'}):
            result, cancelled = service.execute(request('printf "$HOST_ADMIN_TEST_SECRET"; printf ok; printf err >&2; exit 7'))
        self.assertEqual(result['exitCode'], 7)
        self.assertEqual(result['stdout'], 'ok')
        self.assertEqual(result['stderr'], 'err')
        self.assertEqual(result['scope'], 'host-root')
        self.assertFalse(result['timedOut'])
        self.assertFalse(cancelled)

    def test_combined_output_limit(self):
        code = "import os; os.write(1,b'x'*20000); os.write(2,b'y'*20000)"
        result, _ = service.execute(request(python_command(code)))
        self.assertEqual(result['exitCode'], 0)
        self.assertEqual(len(result['stdout'].encode()) + len(result['stderr'].encode()), service.MAX_OUTPUT)
        self.assertTrue(result['truncated'])

    def test_timeout_kills_shell_and_child_group(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = pathlib.Path(folder) / 'survived'
            command = f'(sleep 2; touch {shlex.quote(str(marker))}) & wait'
            before = time.monotonic()
            result, cancelled = service.execute(request(command, timeoutMs=1000))
            self.assertTrue(result['timedOut'])
            self.assertEqual(result['exitCode'], 124)
            self.assertFalse(cancelled)
            self.assertLess(time.monotonic() - before, 2)
            time.sleep(1.1)
            self.assertFalse(marker.exists())

    def test_cancellation_kills_background_children(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = pathlib.Path(folder) / 'survived'
            command = f'(sleep 1; touch {shlex.quote(str(marker))}) & wait'
            start = time.monotonic()
            result, cancelled = service.execute(request(command), lambda: time.monotonic() - start > .1)
            self.assertTrue(cancelled)
            self.assertFalse(result['timedOut'])
            self.assertNotEqual(result['exitCode'], 0)
            time.sleep(1)
            self.assertFalse(marker.exists())

    def test_open_socket_check_does_not_wait_for_socket_timeout(self):
        left, right = socket.socketpair()
        try:
            left.settimeout(5)
            start = time.monotonic()
            self.assertFalse(service.disconnected(left))
            self.assertLess(time.monotonic() - start, .1)
            right.close()
            self.assertTrue(service.disconnected(left))
        finally:
            left.close()
            right.close()


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ha-', dir='/tmp')
        self.path = str(pathlib.Path(self.temp.name) / 'admin.sock')
        self.store = service.RequestStore(pathlib.Path(self.temp.name) / 'state', os.geteuid())
        self.server = service.Server(self.path, {'user_ids': [OWNER], 'peer_uid': 1000}, self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.peer = mock.patch.object(service, 'peer_uid', return_value=1000)
        self.peer.start()
        self.audit = mock.patch.object(service, 'audit')
        self.audit_mock = self.audit.start()
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.store.close()
        self.peer.stop()
        self.audit.stop()
        self.temp.cleanup()

    def post(self, body):
        with contextlib.closing(UnixConnection(self.path)) as connection:
            connection.request('POST', '/execute', json.dumps(body), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, json.loads(response.read())

    def test_health_and_fast_command(self):
        with contextlib.closing(UnixConnection(self.path)) as connection:
            connection.request('GET', '/health')
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), {'ok': True, 'scope': 'host-root'})
        status, result = self.post(request())
        self.assertEqual(status, 200)
        self.assertEqual(result['stdout'], 'hello')

    def test_peer_and_actor_rejection_prevent_execution(self):
        with mock.patch.object(service, 'execute') as execute:
            with mock.patch.object(service, 'peer_uid', return_value=1001):
                self.assertEqual(self.post(request())[0], 403)
            with mock.patch.object(service, 'peer_uid', side_effect=PermissionError):
                self.assertEqual(self.post(request())[0], 403)
            status, result = self.post(request(userId=str(uuid.uuid4())))
            self.assertEqual((status, result['error']), (403, 'actor_not_allowed'))
            execute.assert_not_called()

    def test_missing_fields_bad_json_and_content_type_rejected(self):
        self.assertEqual(self.post({'command': 'true'})[0], 400)
        for body, content_type in (('{', 'application/json'), ('{}', 'text/plain')):
            with contextlib.closing(UnixConnection(self.path)) as connection:
                connection.connect()
                wire = (f'POST /execute HTTP/1.1\r\nHost: localhost\r\nContent-Type: {content_type}\r\n'
                        f'Content-Length: {len(body)}\r\nConnection: close\r\n\r\n{body}').encode()
                connection.sock.sendall(wire)
                response = http.client.HTTPResponse(connection.sock)
                response.begin()
                self.assertEqual(response.status, 400)
                self.assertEqual(json.loads(response.read())['error'], 'invalid_body')

    def test_replay_rejected_and_not_stored_in_audit_or_database(self):
        body = request('printf sentinel-secret-value')
        self.assertEqual(self.post(body)[0], 200)
        with mock.patch.object(service, 'execute') as execute:
            status, result = self.post(body)
            self.assertEqual(status, 409)
            self.assertEqual(result['error'], 'request_already_seen')
            execute.assert_not_called()
        self.assertNotIn('sentinel-secret-value', str(self.audit_mock.call_args_list))
        row = self.store.db.execute('SELECT * FROM requests').fetchone()
        self.assertNotIn('sentinel-secret-value', str(row))
        self.assertEqual(row[3], 'completed')

    def test_disconnect_cancels_command_and_prevents_replay(self):
        marker = pathlib.Path(self.temp.name) / 'survived'
        body = request(f'(sleep 1.3; touch {shlex.quote(str(marker))}) & wait')
        connection = UnixConnection(self.path)
        connection.request('POST', '/execute', json.dumps(body), {'Content-Type': 'application/json'})
        # Wait for the broker's durable claim before simulating a dropped client.
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with self.store.lock:
                row = self.store.db.execute('SELECT status FROM requests WHERE request_id=?', (body['requestId'],)).fetchone()
            if row:
                break
            time.sleep(.01)
        self.assertIsNotNone(row)
        connection.close()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with self.store.lock:
                state = self.store.db.execute('SELECT status FROM requests WHERE request_id=?', (body['requestId'],)).fetchone()[0]
            if state == 'cancelled':
                break
            time.sleep(.02)
        self.assertEqual(state, 'cancelled')
        self.assertEqual(self.post(body)[0], 409)
        time.sleep(1.4)
        self.assertFalse(marker.exists())


class StoreTests(unittest.TestCase):
    def test_restart_preserves_request_tombstones_and_marks_inflight_interrupted(self):
        with tempfile.TemporaryDirectory() as folder:
            store = service.RequestStore(folder, os.geteuid())
            item = request()
            self.assertTrue(store.claim(item))
            store.close()
            store = service.RequestStore(folder, os.geteuid())
            try:
                self.assertFalse(store.claim(item))
                self.assertEqual(store.db.execute('SELECT status FROM requests').fetchone()[0], 'interrupted')
                self.assertEqual((pathlib.Path(folder) / 'requests.sqlite3').stat().st_mode & 0o777, 0o600)
            finally:
                store.close()


if __name__ == '__main__':
    unittest.main()
