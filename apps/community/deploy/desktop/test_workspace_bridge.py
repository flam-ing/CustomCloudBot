import asyncio
import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, mock_open, patch

from aiohttp import WSServerHandshakeError, WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer, make_mocked_request

spec = importlib.util.spec_from_file_location("workspace_bridge", Path(__file__).with_name("workspace-bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class Accessible:
    def __init__(self, states=(), children=(), bounds=(10, 20, 100, 30), pid=42):
        self.states, self.children, self.bounds, self.pid = set(states), list(children), bounds, pid

    @property
    def childCount(self):
        return len(self.children)

    def __getitem__(self, index):
        return self.children[index]

    def get_process_id(self):
        return self.pid

    def getState(self):
        return SimpleNamespace(contains=self.states.__contains__)

    def queryComponent(self):
        return self

    def getExtents(self, coords):
        assert coords == "screen"
        return SimpleNamespace(**dict(zip(("x", "y", "width", "height"), self.bounds)))

    @property
    def name(self):
        raise AssertionError("Input-region lookup must not read accessible names")

    def queryText(self):
        raise AssertionError("Input-region lookup must not read field text")


AX = SimpleNamespace(**{name: name for name in (
    "STATE_ACTIVE", "STATE_VISIBLE", "STATE_SHOWING", "STATE_EDITABLE", "STATE_ENABLED", "STATE_DEFUNCT", "STATE_READ_ONLY")}, DESKTOP_COORDS="screen")
VISIBLE = {AX.STATE_VISIBLE, AX.STATE_SHOWING}
EDITABLE = VISIBLE | {AX.STATE_EDITABLE, AX.STATE_ENABLED}


def accessible_desktop(children, *, active=True, pid=42):
    window = Accessible(VISIBLE | ({AX.STATE_ACTIVE} if active else set()), children)
    return Accessible(children=[Accessible(children=[window], pid=pid)])


class InputRegionTests(unittest.TestCase):
    def test_native_geometry_includes_omnibox_and_nested_editors_without_text(self):
        omnibox = Accessible(EDITABLE, bounds=(100, 45, 800, 32))
        editor = Accessible(EDITABLE, bounds=(321, 456, 280, 42))
        nested = Accessible(children=[Accessible(children=[editor])])
        result = bridge.collect_input_regions(accessible_desktop([omnibox, nested]), AX, lambda pid: pid == 42)
        self.assertTrue(result["available"])
        self.assertEqual(result["regions"], [
            {"x": 100, "y": 45, "width": 800, "height": 32, "inputMode": "text"},
            {"x": 321, "y": 456, "width": 280, "height": 42, "inputMode": "text"},
        ])
        self.assertFalse(result["truncated"])

    def test_readonly_disabled_hidden_defunct_background_and_other_displays_are_excluded(self):
        rejected = [
            Accessible(EDITABLE | {AX.STATE_READ_ONLY}),
            Accessible(EDITABLE - {AX.STATE_ENABLED}),
            Accessible(EDITABLE - {AX.STATE_SHOWING}),
            Accessible(EDITABLE | {AX.STATE_DEFUNCT}),
        ]
        for desktop, predicate in [
            (accessible_desktop(rejected), lambda pid: True),
            (accessible_desktop([Accessible(EDITABLE)], active=False), lambda pid: True),
            (accessible_desktop([Accessible(EDITABLE)]), lambda pid: False),
        ]:
            self.assertEqual(bridge.collect_input_regions(desktop, AX, predicate)["regions"], [])

    def test_offscreen_fields_are_clipped_duplicates_removed_and_tree_is_bounded(self):
        clipped = Accessible(EDITABLE, bounds=(-20, -10, 60, 40))
        duplicate = Accessible(EDITABLE, bounds=(-20, -10, 60, 40))
        outside = Accessible(EDITABLE, bounds=(-500, 50, 30, 20))
        empty = Accessible(EDITABLE, bounds=(20, 50, 0, 20))
        result = bridge.collect_input_regions(accessible_desktop([clipped, duplicate, outside, empty]), AX, lambda pid: True)
        self.assertEqual(result["regions"], [{"x": 0, "y": 0, "width": 40, "height": 30, "inputMode": "text"}])
        many = [Accessible(EDITABLE, bounds=(index, 20, 10, 10)) for index in range(400)]
        result = bridge.collect_input_regions(accessible_desktop(many), AX, lambda pid: True)
        self.assertEqual(len(result["regions"]), bridge.MAX_INPUT_REGIONS)
        self.assertTrue(result["truncated"])
        cycle = Accessible(); cycle.children = [cycle]
        result = bridge.collect_input_regions(accessible_desktop([cycle]), AX, lambda pid: True)
        self.assertEqual(result["regions"], [])
        result = bridge.collect_input_regions(accessible_desktop(many), AX, lambda pid: True, budget=0)
        self.assertTrue(result["truncated"])

    def test_process_filter_accepts_only_browser_on_main_display(self):
        with patch.object(bridge.os, "readlink", return_value="/opt/google/chrome/chrome"):
            with patch("builtins.open", mock_open(read_data=b"DISPLAY=:99\0OTHER=value\0")):
                self.assertTrue(bridge.browser_on_main_display(42))
            for environment in (b"DISPLAY=:100\0", b"DISPLAY=:101\0", b"UNRELATED=DISPLAY=:99\0"):
                with patch("builtins.open", mock_open(read_data=environment)):
                    self.assertFalse(bridge.browser_on_main_display(42))
        with patch.object(bridge.os, "readlink", return_value="/usr/bin/xterm"):
            self.assertFalse(bridge.browser_on_main_display(42))

    def test_container_keeps_non_root_sandbox_and_shared_session_bus(self):
        root = Path(__file__).parent
        for name in ("Dockerfile", "Dockerfile.managed"):
            source = (root / name).read_text()
            self.assertIn("python3-pyatspi", source)
            self.assertIn("at-spi2-core", source)
            self.assertIn("USER desktop", source)
        startup = (root / "entrypoint.sh").read_text()
        self.assertIn('exec dbus-run-session -- "$0" "$@"', startup)
        self.assertIn("--force-renderer-accessibility", startup)
        self.assertNotIn("  --no-sandbox", startup)


class InputRegionServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_cache_coalesces_concurrent_readers_and_expired_positions_are_never_reused(self):
        service = bridge.BrowserInputRegions(timeout=0.02, cache_seconds=0.2)
        sample = {**bridge.empty_input_regions(True), "regions": [{"x": 10, "y": 20, "width": 100, "height": 30}]}
        service.read = AsyncMock(return_value=sample)
        results = await asyncio.gather(*(service.get() for _ in range(8)))
        self.assertTrue(all(item == sample for item in results))
        self.assertEqual(service.read.await_count, 1)
        service.cached_at = 0
        async def blocked():
            await asyncio.sleep(5)
        service.read = blocked
        result = await service.get()
        self.assertFalse(result["available"])
        self.assertEqual(result["regions"], [])
        await service.close()

    async def test_native_query_does_not_block_health_and_has_the_same_origin_restrictions(self):
        with tempfile.TemporaryDirectory() as directory:
            reader = SimpleNamespace(get=AsyncMock(return_value=bridge.empty_input_regions(True)), close=AsyncMock())
            client = TestClient(TestServer(bridge.create_app(directory, input_regions=reader)))
            await client.start_server()
            try:
                response = await client.get("/browser/input-regions")
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertEqual((await response.json())["regions"], [])
                self.assertEqual((await client.get("/browser/input-regions", headers={"Origin": "https://example.test"})).status, 403)
                entered, release = asyncio.Event(), asyncio.Event()
                async def delayed():
                    entered.set()
                    await release.wait()
                    return bridge.empty_input_regions(True)
                reader.get = delayed
                pending = asyncio.create_task(client.get("/browser/input-regions"))
                await entered.wait()
                self.assertEqual((await asyncio.wait_for(client.get("/health"), 0.5)).status, 200)
                release.set()
                self.assertEqual((await pending).status, 200)
            finally:
                await client.close()
            reader.close.assert_awaited_once()


class FileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name) / "home"
        self.root.mkdir()
        self.outside = Path(self.directory.name) / "outside.txt"
        self.outside.write_text("OUTSIDE_SECRET")
        (self.root / "inside.txt").write_text("inside")
        (self.root / "folder").mkdir()
        self.files = bridge.HomeFiles(self.root)

    def tearDown(self):
        self.files.close()
        self.directory.cleanup()

    def test_relative_listing_download_and_guards(self):
        (self.root / "escape").symlink_to(self.outside)
        (self.root / "outside-dir").symlink_to(self.root.parent, target_is_directory=True)
        (self.root / "inside-link").symlink_to(self.root / "inside.txt")
        result = self.files.list("")
        self.assertEqual(result["path"], "")
        self.assertEqual([item["name"] for item in result["entries"]], ["folder", "inside.txt"])
        self.assertEqual(result["entries"][0]["type"], "directory")
        self.assertEqual(self.files.read("./inside.txt"), (b"inside", "inside.txt"))
        self.assertNotIn(str(self.root), json.dumps(result))
        for value in ("../outside.txt", "/etc/passwd", "folder/../../outside.txt", "a\\b", "bad\0name"):
            with self.assertRaises(web.HTTPBadRequest):
                self.files.read(value)
        for value in ("escape", "inside-link", "outside-dir/outside.txt", "folder"):
            with self.assertRaises(web.HTTPNotFound):
                self.files.read(value)

    def test_symlink_swap_at_the_final_open_cannot_escape(self):
        real_open = os.open
        def swapped_open(path, flags, *args, **kwargs):
            if path == "inside.txt":
                (self.root / "inside.txt").unlink()
                (self.root / "inside.txt").symlink_to(self.outside)
            return real_open(path, flags, *args, **kwargs)
        with patch.object(bridge.os, "open", side_effect=swapped_open):
            with self.assertRaises(web.HTTPNotFound):
                self.files.read("inside.txt")

    def test_file_size_and_listing_are_bounded(self):
        with (self.root / "large").open("wb") as target:
            target.truncate(bridge.MAX_FILE + 1)
        with self.assertRaises(web.HTTPRequestEntityTooLarge):
            self.files.read("large")
        for index in range(1001):
            (self.root / f"item-{index}").touch()
        result = self.files.list("")
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["entries"]), 1000)


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.app = bridge.create_app(self.root)
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.directory.cleanup()

    async def output_until(self, ws, expected):
        text = ""
        async with asyncio.timeout(5):
            while expected not in text:
                message = await ws.receive()
                self.assertEqual(message.type, WSMsgType.TEXT, message)
                event = json.loads(message.data)
                if event["type"] == "output":
                    text += event["data"]
        return text

    async def test_health_private_peer_and_origin_rules(self):
        response = await self.client.get("/health")
        self.assertEqual(await response.json(), {"ok": True, "terminal": True, "files": True})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual((await self.client.get("/files", headers={"Origin": "https://untrusted.example"})).status, 403)
        for peer in ("127.0.0.1", "::1", "::ffff:172.30.50.2", "172.30.50.2"):
            self.assertTrue(bridge.allowed_peer(peer))
        for peer in ("172.30.50.3", "192.168.0.1", "8.8.8.8", None):
            self.assertFalse(bridge.allowed_peer(peer))
        class Transport:
            def get_extra_info(self, _name):
                return ("192.168.0.1", 2345)
        request = make_mocked_request("GET", "/health", headers={"X-Forwarded-For": "172.30.50.2"}, transport=Transport())
        with self.assertRaises(web.HTTPForbidden):
            await self.app.middlewares[0](request, lambda _request: None)
        with self.assertRaises(WSServerHandshakeError) as rejected:
            await self.client.ws_connect("/terminal?session=" + "a" * 64, headers={"Origin": "https://untrusted.example"})
        self.assertEqual(rejected.exception.status, 403)

    async def test_http_files_remain_relative_and_force_download(self):
        (self.root / "page.html").write_text("<script>document.body.remove()</script>")
        result = await (await self.client.get("/files?path=")).json()
        self.assertEqual(result["entries"][0]["path"], "page.html")
        response = await self.client.get("/file?path=page.html")
        self.assertEqual(response.content_type, "application/octet-stream")
        self.assertTrue(response.headers["Content-Disposition"].startswith("attachment;"))
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual((await self.client.get("/file?path=../outside")).status, 400)
        self.assertEqual((await self.client.get("/file?path=missing")).status, 404)
        self.assertEqual((await self.client.get("/terminal?session=" + "a" * 64)).status, 400)

    async def test_pty_resize_reattach_isolation_utf8_and_exit(self):
        first = await self.client.ws_connect("/terminal?session=" + "a" * 64)
        self.assertEqual((await first.receive_json())["type"], "ready")
        await first.send_json({"type": "input", "data": "value=kept\nprintf '%s%s\\n' 'FIRST_' 'OK'\n"})
        await self.output_until(first, "FIRST_OK")
        await first.send_json({"type": "resize", "cols": 123, "rows": 45})
        await first.send_json({"type": "input", "data": "stty size\n"})
        await self.output_until(first, "45 123")
        second = await self.client.ws_connect("/terminal?session=" + "b" * 64)
        await second.send_json({"type": "input", "data": "printf '%s=%s\\n' 'SEPARATE' \"${value:-empty}\"\n"})
        await self.output_until(second, "SEPARATE=empty")
        await first.close()
        await second.send_json({"type": "input", "data": "printf '%s%s\\n' 'SECOND_' 'ALIVE'\n"})
        await self.output_until(second, "SECOND_ALIVE")
        reconnect = await self.client.ws_connect("/terminal?session=" + "a" * 64)
        await self.output_until(reconnect, "FIRST_OK")
        await reconnect.send_json({"type": "input", "data": "printf '%s=%s\\n' 'PERSIST' \"$value\"\n"})
        await self.output_until(reconnect, "PERSIST=kept")
        await reconnect.send_json({"type": "input", "data": "printf '\\355'; sleep 0.03; printf '\\225\\234\\352\\270\\200\\n'\n"})
        output = await self.output_until(reconnect, "한글")
        self.assertNotIn("\ufffd", output)
        await reconnect.send_json({"type": "input", "data": "exit 7\n"})
        async with asyncio.timeout(5):
            while True:
                event = await reconnect.receive_json()
                if event["type"] == "exit":
                    self.assertEqual(event["code"], 7)
                    break
        await second.close()

    async def test_terminal_input_limits_close_only_the_invalid_viewer(self):
        path = "/terminal?session=" + "a" * 64
        first = await self.client.ws_connect(path)
        second = await self.client.ws_connect(path)
        await first.send_json({"type": "input", "data": "x" * (bridge.MAX_INPUT + 1)})
        async with asyncio.timeout(5):
            while (await first.receive()).type == WSMsgType.TEXT:
                pass
        self.assertEqual(first.close_code, 1008)
        await second.send_json({"type": "input", "data": "printf '%s%s\\n' 'OTHER_' 'ALIVE'\n"})
        await self.output_until(second, "OTHER_ALIVE")
        await second.send_json({"type": "resize", "cols": 999999, "rows": 40})
        async with asyncio.timeout(5):
            while (await second.receive()).type == WSMsgType.TEXT:
                pass
        self.assertEqual(second.close_code, 1008)


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_backpressure_closes_only_the_slow_viewer_even_before_its_sender_starts(self):
        class SlowSocket:
            closed = False

            async def send_json(self, _value):
                await asyncio.Future()

            async def close(self):
                self.closed = True

        terminal = SimpleNamespace(clients=set(), last_activity=time.monotonic())
        socket = SlowSocket()
        viewer = bridge.TerminalClient(terminal, socket)
        terminal.clients.add(viewer)
        for _ in range(40):
            viewer.offer({"type": "output", "data": "x" * 16000})
        await viewer.closer
        await asyncio.gather(viewer.task, return_exceptions=True)
        self.assertTrue(socket.closed)
        self.assertNotIn(viewer, terminal.clients)
        self.assertLessEqual(viewer.pending, bridge.MAX_PENDING)

    async def test_capacity_replay_limit_and_idle_cleanup_do_not_kill_other_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            sessions = bridge.Terminals(Path(directory), max_sessions=2, idle_seconds=600)
            try:
                first = sessions.get("a" * 64)
                second = sessions.get("b" * 64)
                self.assertIs(sessions.get("a" * 64), first)
                with self.assertRaises(web.HTTPTooManyRequests):
                    sessions.get("c" * 64)
                with self.assertRaises(web.HTTPBadRequest):
                    sessions.get("../bad")
                first.emit("가" * 100000)
                self.assertLessEqual(len(first.replay.encode("utf-8")), bridge.MAX_REPLAY)
                now = time.monotonic()
                first.last_activity = now - 601
                second.last_activity = now
                await sessions.reap(now)
                self.assertNotIn("a" * 64, sessions.sessions)
                self.assertIsNotNone(first.code)
                with self.assertRaises(ProcessLookupError):
                    os.kill(first.pid, 0)
                os.kill(second.pid, 0)
                second.feed("printf '%s%s\\n' 'SURVIVING_' 'SESSION'\n")
                async with asyncio.timeout(5):
                    while "SURVIVING_SESSION" not in second.replay:
                        await asyncio.sleep(0.01)
            finally:
                await sessions.close()


if __name__ == "__main__":
    unittest.main()
