import json
import os
import re
import urllib.request
from urllib.parse import urlsplit


def verify(origin, expected):
    parsed = urlsplit(origin)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ['', '/']):
        raise ValueError('Set OCI_PUBLIC_ORIGIN to the operator HTTPS origin')
    if not re.fullmatch(r'[a-f0-9]{40}', expected):
        raise ValueError('Expected an immutable release SHA')
    origin = origin.rstrip('/')
    with urllib.request.urlopen(origin + '/api/health', timeout=30) as response:
        health = json.load(response)
    if health.get('ok') is not True or health.get('release') != expected:
        raise RuntimeError('Public release does not match the tested SHA')
    with urllib.request.urlopen(origin + '/api/brand', timeout=30) as response:
        brand = json.load(response)
    with urllib.request.urlopen(origin + '/manifest.webmanifest', timeout=30) as response:
        manifest = json.load(response)
    if not brand.get('name') or manifest.get('name') != brand['name']:
        raise RuntimeError('Installed app name does not match the configured brand')
    for path in ['/', '/app.js', '/agent-presence.js', '/agent-presence.css',
                 '/notification-center.js', '/notification-center.css', '/invite-links.mjs',
                 '/profile-settings.js', '/profile-settings.css', '/room-sharing.js', '/room-sharing.css',
                 '/conversation-ui.mjs', '/workspace-windows.js',
                 '/branch-graph.mjs', '/branch-graph.css',
                 '/media/agent/idle.mp4', '/media/agent/working.mp4',
                 '/media/agent/waiting.mp4', '/media/agent/error.mp4', '/media/agent/idle-poster.jpg',
                 '/media/agent/idle.webp', '/media/agent/idle-poster.webp',
                 '/media/agent/working.webp', '/media/agent/working-poster.webp',
                 '/media/agent/waiting.webp', '/media/agent/waiting-poster.webp',
                 '/media/agent/error.webp', '/media/agent/error-poster.webp',
                 '/setup.js', '/setup.css', '/setup-guide', '/desktop.js', '/manifest.webmanifest',
                 '/sw.js', '/icons/cloud-agent-v1-192.png', '/icons/app-icon-v2-512.png', '/icons/app-icon-v2-192.png',
                 '/icons/app-icon-v2-180.png', '/icons/app-icon-v2-48.png']:
        with urllib.request.urlopen(origin + path, timeout=30) as response:
            if response.status != 200 or not response.read(1):
                raise RuntimeError('Public asset unavailable: ' + path)
    print('Public HTTPS and expected release verified:', expected)


if __name__ == '__main__':
    verify(os.environ['OCI_PUBLIC_ORIGIN'], os.environ['EXPECTED_SHA'])
