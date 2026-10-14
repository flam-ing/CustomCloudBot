import importlib.util
import json
import os
import shutil
import subprocess
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
    def test_indentless_volume_sequence_preserved_and_idempotent(self):
        source = FIXTURE.replace('      - example-data:/data', '    - example-data:/data\n    - /private/folder:/shared:ro')
        changed = install.patch_manifest(source, OWNER)
        self.assertIn('    volumes:\n    - /run/community-admin:/run/community-admin:ro,z\n    - example-data:/data', changed)
        self.assertIn('    - /private/folder:/shared:ro\n    read_only: true', changed)
        self.assertEqual(install.patch_manifest(changed, OWNER), changed)
        self.assertEqual(source.split('  desktop:')[1], changed.split('  desktop:')[1])

    def test_mixed_volume_sequence_indentation_rejected(self):
        source = FIXTURE.replace('      - example-data:/data', '    - example-data:/data\n      - /private/folder:/shared:ro')
        with self.assertRaisesRegex(ValueError, 'Mixed volume sequence indentation'):
            install.patch_manifest(source, OWNER)

    @unittest.skipUnless(shutil.which('ruby'), 'Ruby YAML parser is not installed')
    def test_generated_manifests_parse_with_yaml_parser_for_both_sequence_styles(self):
        for source in [FIXTURE, FIXTURE.replace('      - example-data:/data', '    - example-data:/data')]:
            for document in [source, install.patch_manifest(source, OWNER)]:
                with self.subTest(indentless='    - example-data' in document):
                    parsed = subprocess.run([shutil.which('ruby'), '-rpsych', '-e', 'Psych.parse(STDIN.read)'],
                                            input=document, text=True, capture_output=True, timeout=10)
                    self.assertEqual(parsed.returncode, 0, parsed.stderr)

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
    def test_app_only_compose_validation_identifies_baseline_or_updated(self):
        for phase in ['Baseline', 'Updated']:
            run = Mock(side_effect=RuntimeError('safe classified diagnostic'))
            with self.subTest(phase=phase), self.assertRaisesRegex(RuntimeError, phase + ' application compose validation failed'):
                install.validate_compose(run, ['docker', 'compose', '-f', '/private/compose.yml'], phase)
            self.assertEqual(run.call_args.args[-3:], ('config', '--quiet', 'app'))

    def test_structural_fallback_hides_credentials_paths_ids_and_arbitrary_numbers(self):
        source = ('service "my-private-service" refers to undefined network private-network: invalid compose project; '
                  'sk-live-abcdef123456 token@example.com /home/private/.env 11111111-2222-4333-8444-555555555555 '
                  '123456789 168.107.91.96 line 27')
        safe = install.structural_stderr(source)
        for private in ['my-private-service', 'private-network', 'sk-live-abcdef123456', 'token@example.com',
                        '/home/private/.env', '11111111-2222-4333-8444-555555555555', '123456789', '168.107.91.96']:
            self.assertNotIn(private, safe)
        self.assertIn('refers to undefined network', safe)
        self.assertIn('line 27', safe)
        self.assertLessEqual(len(install.structural_stderr(source * 100)), 1000)

    def test_command_runner_preserves_compose_cwd(self):
        with patch.object(install.subprocess, 'run', return_value=SimpleNamespace(stdout='ok', stderr='', returncode=0)) as run:
            self.assertEqual(install.run_command('docker', 'compose', 'config', '--quiet', cwd=Path('/srv/app/apps/community/deploy')), 'ok')
            self.assertEqual(run.call_args.kwargs['cwd'], Path('/srv/app/apps/community/deploy'))

    def test_command_failure_diagnostics_never_expose_values(self):
        for stderr, expected in [
                ('required variable COMMUNITY_ORIGIN is missing a value: secret-value', 'missing_environment_variable=COMMUNITY_ORIGIN'),
                ('env file /private/secret-value/.env.production not found: no such file or directory', 'missing_environment_file'),
                ('validating manifest: services.app.environment.BAD must be a string, got secret-value', 'invalid_compose_field=services.app.environment.BAD'),
                ('yaml: line 32: invalid content secret-value', 'invalid_yaml_line=32'),
                ('secret-value permission denied', 'permission_denied'),
                ('unknown error secret-value', 'unclassified')]:
            with self.subTest(stderr=stderr):
                error = install.command_failure(('docker', 'compose', 'config'), SimpleNamespace(stderr=stderr, returncode=1))
                self.assertIn('docker compose rc=1', str(error))
                self.assertIn(expected, str(error))
                self.assertNotIn('secret-value', str(error))

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
