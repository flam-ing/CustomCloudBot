import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('host_admin_install', Path(__file__).with_name('install.py'))
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)
OWNER = '11111111-2222-4333-8444-555555555555'
FIXTURE = '''name: example
services:
  app:
    image: example-app:local
    environment:
      EXISTING_PRIVATE_VALUE: '${PRIVATE_VALUE}'
    volumes:
      - example-data:/data
    read_only: true
  desktop:
    environment:
      KEEP_THIS: unchanged
    volumes:
      - example-home:/home
volumes:
  example-data:
  example-home:
'''


class ManifestTests(unittest.TestCase):
    def test_idempotent_and_preserves_unrelated_settings(self):
        changed = install.patch_manifest(FIXTURE, OWNER)
        self.assertEqual(install.patch_manifest(changed, OWNER), changed)
        for line in FIXTURE.splitlines(keepends=True):
            self.assertIn(line, changed)
        self.assertEqual(changed.split('  desktop:')[1], FIXTURE.split('  desktop:')[1])
        self.assertEqual(changed.count(install.SOCKET), 1)
        self.assertEqual(changed.count('/run/community-admin:/run/community-admin:ro,z'), 1)
        new_owner = OWNER.replace('11111111', 'aaaaaaaa')
        replaced = install.patch_manifest(changed, new_owner)
        self.assertNotIn(OWNER, replaced)
        self.assertIn(new_owner, replaced)

    def test_actual_repository_manifest(self):
        source = Path(__file__).parent.parent.joinpath('compose.yml').read_text()
        changed = install.patch_manifest(source, OWNER)
        self.assertEqual(install.patch_manifest(changed, OWNER), changed)
        self.assertEqual(source.split('  openclaw:')[1], changed.split('  openclaw:')[1])

    def test_rejects_invalid_structure_and_ambiguous_mount(self):
        cases = [FIXTURE.replace('services:', 'other:'),
                 FIXTURE.replace('  app:', '  other:'),
                 FIXTURE.replace('    environment:', '    environment: {}', 1),
                 FIXTURE.replace('      EXISTING_PRIVATE_VALUE:', '      - EXISTING_PRIVATE_VALUE=', 1),
                 FIXTURE.replace('    volumes:', '    volumes: []', 1),
                 FIXTURE.replace('    read_only: true', '    environment:\n      OTHER: value'),
                 FIXTURE.replace('    read_only: true', '  app:\n    environment:\n      OTHER: value'),
                 FIXTURE.replace('      - example-data:/data', '      - /run/community-admin:/run/community-admin:rw'),
                 FIXTURE.replace('      - example-data:/data', '      - /run/community-admin-other:/data'),
                 FIXTURE.replace('      - example-data:/data', '      - type: bind\n        source: /run/community-admin'),
                 FIXTURE.replace('      EXISTING_PRIVATE_VALUE:', '      VALUE: first\n      VALUE:'),
                 FIXTURE.replace('      - example-data:/data', ('      - /run/community-admin:/run/community-admin:ro,z\n' * 2).rstrip())]
        for source in cases:
            with self.subTest(source=source), self.assertRaises(ValueError):
                install.patch_manifest(source, OWNER)
        for owner in [None, '', 'owner', OWNER.upper(), '00000000-0000-0000-0000-000000000000']:
            # OWNER contains no letters; use an uppercase UUID for that case.
            if owner == OWNER:
                owner = 'AAAAAAAA-2222-4333-8444-555555555555'
            with self.subTest(owner=owner), self.assertRaises(ValueError):
                install.patch_manifest(FIXTURE, owner)


class RollbackTests(unittest.TestCase):
    def test_restores_service_code_file_modes_and_service_state(self):
        for enabled, active in [(True, True), (False, True), (False, False)]:
            with self.subTest(enabled=enabled, active=active), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                backup = root / 'backup'
                backup.mkdir()
                code = root / 'service.py'
                config = root / 'host-admin.json'
                code.write_text('new service')
                config.write_text('new config')
                (backup / 'service.py').write_text('previous service')
                calls = Mock()
                with patch.object(install.os, 'chown'):
                    install.restore(backup, [code, config], {code: 0o750},
                                    {'enabled': enabled, 'active': active}, ['docker', 'compose'], calls, True, True)
                self.assertEqual(code.read_text(), 'previous service')
                self.assertEqual(stat.S_IMODE(code.stat().st_mode), 0o750)
                self.assertFalse(config.exists())
                args = [call.args for call in calls.call_args_list]
                self.assertIn(('systemctl', 'stop', install.SERVICE), args)
                self.assertIn(('systemctl', 'disable', install.SERVICE), args)
                self.assertEqual(('systemctl', 'enable', install.SERVICE) in args, enabled)
                self.assertEqual(('systemctl', 'start', install.SERVICE) in args, active)
                self.assertEqual(args[-1][:2], ('docker', 'compose'))

    def test_early_failure_does_not_restart_untouched_processes(self):
        calls = Mock()
        install.restore(Path('/unused'), [], {}, {'enabled': True, 'active': True}, [], calls, False, False)
        calls.assert_called_once_with('systemctl', 'daemon-reload')

    def test_attempts_remaining_restoration_after_one_failure(self):
        calls = Mock(side_effect=[RuntimeError('stop failed'), None, None, None, None])
        with self.assertRaisesRegex(RuntimeError, 'Rollback incomplete'):
            install.restore(Path('/unused'), [], {}, {'enabled': True, 'active': True}, [], calls, True, False)
        self.assertEqual(calls.call_args.args, ('systemctl', 'start', install.SERVICE))


class BoundaryTests(unittest.TestCase):
    def test_same_deployment_lock_acquired_before_install(self):
        order = []
        with patch.object(install.os, 'geteuid', return_value=0), patch.object(install.os, 'umask'), \
                patch.object(install.os, 'open', return_value=17) as opened, \
                patch.object(install.os, 'close') as closed, \
                patch.object(install.os, 'fstat', return_value=SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)), \
                patch.object(install.fcntl, 'flock', side_effect=lambda *_: order.append('lock')), \
                patch.object(install, 'install_locked', side_effect=lambda: order.append('install')):
            install.main()
        self.assertEqual(order, ['lock', 'install'])
        self.assertEqual(opened.call_args.args[0], '/run/lock/openclaw-deploy.lock')
        closed.assert_called_once_with(17)

    def test_uid1000_and_host_mapping_required(self):
        for identity, mapping, okay in [({'uid': 1000, 'groups': [1000]}, '0 0 4294967295\n', True),
                                       ({'uid': 0, 'groups': [0]}, '0 0 4294967295\n', False),
                                       ({'uid': 1000, 'groups': [1000]}, '0 100000 65536\n', False),
                                       ({'uid': 1000, 'groups': [999]}, '0 0 4294967295\n', False)]:
            run = Mock(side_effect=[json.dumps(identity), '123'])
            with self.subTest(identity=identity, mapping=mapping), patch.object(Path, 'read_text', return_value=mapping):
                if okay:
                    install.verify_app_uid(run, 'example-app-1')
                else:
                    with self.assertRaises(RuntimeError):
                        install.verify_app_uid(run, 'example-app-1')

    def test_service_state_capture_and_unsupported_state_rejection(self):
        with patch.object(install.subprocess, 'run', side_effect=[SimpleNamespace(stdout='loaded\n', returncode=0),
                                                                SimpleNamespace(stdout='enabled\n', returncode=0),
                                                                SimpleNamespace(stdout='active\n', returncode=0)]):
            self.assertEqual(install.unit_state(), {'enabled': True, 'active': True})
        with patch.object(install.subprocess, 'run', return_value=SimpleNamespace(stdout='masked\n', returncode=1)):
            with self.assertRaisesRegex(RuntimeError, 'LoadState state=masked rc=1'):
                install.unit_state()

    def test_missing_unit_checked_independently_of_systemd_enabled_exit_variant(self):
        for enabled_returncode in (1, 4):
            def result(args, **_kwargs):
                if args[1] == 'show':
                    return SimpleNamespace(stdout='not-found\n', returncode=0)
                if args[1] == 'is-enabled':
                    return SimpleNamespace(stdout='', returncode=enabled_returncode)
                raise AssertionError('Missing unit must not query active state')
            with self.subTest(enabled_returncode=enabled_returncode), patch.object(install.subprocess, 'run', side_effect=result) as run:
                self.assertEqual(install.unit_state(), {'enabled': False, 'active': False})
                run.assert_called_once_with(['systemctl', 'show', '--property=LoadState', '--value', install.SERVICE],
                                            capture_output=True, text=True, timeout=10)

    def test_failed_or_unknown_load_state_fails_closed_with_safe_diagnostic(self):
        for stdout, returncode, diagnostic in [('not-found\n', 1, 'state=not-found rc=1'),
                                                ('\n', 1, 'state=<empty> rc=1'),
                                                ('sensitive-unexpected-value\n', 0, 'state=<unexpected> rc=0')]:
            with self.subTest(stdout=stdout), patch.object(install.subprocess, 'run',
                    return_value=SimpleNamespace(stdout=stdout, returncode=returncode)):
                with self.assertRaises(RuntimeError) as caught:
                    install.unit_state()
                self.assertIn(diagnostic, str(caught.exception))
                self.assertNotIn('sensitive-unexpected-value', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
