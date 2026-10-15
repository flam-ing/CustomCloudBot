import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageLevel, filesystemLevel, hostMetrics, hostAlerts, monitorProblem, dashboardData, formatGiB, formatPercent, mountLabel } from '../public/host-dashboard.mjs';
import { summarizeServiceResult, summarizeModelCheck, serviceStatus, sortServices, checkLabel } from '../public/integrations-ui.mjs';
import { workspaceBounds, freeCascadeSlot, workspaceLayers, createWorkspaceWindows } from '../public/workspace-windows.js';
import { TERMINAL_THEME, TERMINAL_FONT } from '../public/workspace-terminal.js';
import { readMonitor, explainMonitor } from '../monitor.mjs';

const snapshot = (over = {}) => ({ available: true, scope: 'a1-host', timestamp: Date.now(), cpuCount: 4, cpuUsedPercent: 42, memoryUsedGiB: 12, memoryTotalGiB: 24, diskTotalGiB: 2000, diskUsedGiB: 1200, diskUsedPercent: 60, diskFreeGiB: 800, diskUnallocatedGiB: 0, filesystems: [{ mount: '/', totalGiB: 2000, usedGiB: 1200, freeGiB: 800, usedPercent: 60 }], ...over });

test('usage colors switch at 70% and 90%; filesystems only near full', () => {
  assert.deepEqual([0, 69.9, 70, 89.9, 90, 100].map(usageLevel), ['ok', 'ok', 'warning', 'warning', 'danger', 'danger']);
  assert.equal(usageLevel(NaN), 'unknown');
  assert.deepEqual([84.9, 85, 95].map(filesystemLevel), ['ok', 'warning', 'danger']);
});

test('dashboard numbers use thousands separators and plain labels', () => {
  assert.equal(formatGiB(1532.04), '1,532.0 GiB');
  assert.equal(formatPercent(97.06), '97.1%');
  const [cpu, memory, disk] = hostMetrics(snapshot());
  assert.equal(cpu.detail, '코어 4개 전체 기준');
  assert.equal(memory.detail, '전체 24.0 GiB 중 50.0% 사용');
  assert.equal(disk.detail, '2,000.0 GiB 중 1,200.0 GiB 사용');
  assert.equal(mountLabel('/'), '시스템 디스크(/)');
});

test('attention strip counts every metric at or above 70% and nearly full disks, most serious first', () => {
  assert.deepEqual(hostAlerts(snapshot()), []);
  const alerts = hostAlerts(snapshot({ cpuUsedPercent: 76, diskUsedPercent: 97, filesystems: [{ mount: '/data', totalGiB: 10, usedGiB: 9.6, freeGiB: .4, usedPercent: 96 }] }));
  assert.equal(alerts.length, 3);
  assert.deepEqual(alerts.map(a => a.level), ['danger', 'danger', 'warning']);
  assert.match(alerts.at(-1).text, /CPU 76\.0%/);
});

test('each stop reason gets its own explanation, and the last numbers stay available', () => {
  const now = Date.now();
  assert.equal(monitorProblem(snapshot()), null);
  assert.equal(monitorProblem({ available: false, reason: 'missing' }).reason, 'missing');
  assert.match(monitorProblem({ available: false, reason: 'stale', last: { timestamp: now - 5 * 60000 } }, { now }).title, /5분째/);
  assert.match(monitorProblem({ available: false, reason: 'future' }).text, /시계/);
  assert.match(monitorProblem({ available: false, reason: 'network' }).title, /연결하지 못했습니다/);
  assert.equal(monitorProblem({ ...snapshot(), scope: 'legacy' }).reason, 'old-collector');
  const live = snapshot();
  assert.deepEqual(dashboardData({ available: false, reason: 'missing' }, live), { data: live, live: false });
  const stale = { ...snapshot(), available: undefined };
  assert.equal(dashboardData({ available: false, reason: 'stale', last: stale }, null).data, stale);
  assert.deepEqual(dashboardData({ available: false, reason: 'invalid' }, null), { data: null, live: false });
});

test('readMonitor reports why data is unusable and keeps a stale snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-reason-')), path = join(dir, 'status.json');
  try {
    assert.deepEqual(await readMonitor(path), { available: false, reason: 'missing' });
    assert.deepEqual(await readMonitor(''), { available: false, reason: 'missing' });
    await writeFile(path, '{not json'); assert.equal((await readMonitor(path)).reason, 'invalid');
    const valid = { timestamp: Date.now(), memoryUsedGiB: 1, memoryTotalGiB: 2, diskUsedPercent: 3, diskFreeGiB: 4, communityMemoryGiB: 1, communityLimitGiB: 2, communityCpuLimit: 1, personalLimitGiB: 2, personalCpuLimit: 1 };
    await writeFile(path, JSON.stringify(valid)); assert.equal((await readMonitor(path)).available, true);
    await writeFile(path, JSON.stringify({ ...valid, timestamp: Date.now() + 60000 })); assert.equal((await readMonitor(path)).reason, 'future');
    await writeFile(path, JSON.stringify({ ...valid, timestamp: Date.now() - 240000 }));
    const stale = await readMonitor(path);
    assert.equal(stale.reason, 'stale'); assert.equal(stale.available, false); assert.equal(stale.last.diskFreeGiB, 4);
    assert.match(explainMonitor(stale), /3분 넘게 갱신되지 않았습니다.*판단할 수 없습니다/);
    assert.doesNotMatch(explainMonitor({ ...snapshot(), communityMemoryGiB: 1 }), /OCPU|A1|미할당/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('connection checks are summarized in plain Korean', () => {
  assert.equal(summarizeServiceResult('naver-mail', 'inbox', { total: 1532, messages: [{ read: false }, { read: true }, { read: false }] }), '받은 메일 1,532통 · 최근 3통 중 안 읽은 메일 2통');
  assert.equal(summarizeServiceResult('kakao-calendar', 'calendars', { calendars: [{}, {}], subscribe_calendars: [{}] }), '캘린더 2개 · 구독 캘린더 1개');
  assert.equal(summarizeServiceResult('telegram', 'profile', { ok: true, username: 'helper_bot' }), '@helper_bot 확인됨');
  assert.match(summarizeServiceResult('meta', 'profile', { type: 'app', name: 'My App', personalAccess: false }), /앱 인증 확인됨/);
  assert.equal(summarizeServiceResult('resend', 'domains', { domains: [{ status: 'verified' }, { status: 'pending' }] }), '도메인 2개 · 인증 완료 1개');
  assert.equal(summarizeServiceResult('firecrawl', 'credits', { success: true, data: { remainingCredits: 12000 } }), '남은 크레딧 12,000');
  assert.equal(summarizeServiceResult('tavily', 'search', { results: [{}, {}] }), '검색 결과 2건');
  assert.equal(summarizeServiceResult('x', 'unknown', null), '응답을 받았습니다');
  assert.equal(checkLabel('inbox'), '받은 메일 확인');
  assert.deepEqual(serviceStatus({ configured: true }), { state: 'on', label: '등록됨' });
  assert.deepEqual(serviceStatus({}), { state: 'off', label: '미등록' });
  assert.deepEqual(sortServices([{ id: 'a' }, { id: 'b', configured: true }, { id: 'c' }, { id: 'd', configured: true }]).map(s => s.id), ['b', 'd', 'a', 'c']);
  const models = summarizeModelCheck({ models: [{ providers: ['openai'] }, { providers: ['openai', 'xai'] }], failures: [{ provider: 'groq' }] });
  assert.equal(models.ok, false);
  assert.equal(models.lines[0], '공급자 2곳에서 모델 2개를 쓸 수 있습니다.');
  assert.match(models.lines.at(-1), /groq/);
});

test('new workspace windows cascade, stop above the composer and stay in their layer band', () => {
  assert.equal(freeCascadeSlot([]), 0);
  assert.equal(freeCascadeSlot([0, 1, 3]), 2);
  const first = workspaceBounds({}, { width: 1024, height: 720 }, 0, 114);
  assert.ok(first.top + first.height <= 720 - 114, 'default height ends above the composer');
  const second = workspaceBounds({}, { width: 1024, height: 720 }, 28, 114);
  assert.notDeepEqual([second.left, second.top], [first.left, first.top]);
  assert.deepEqual(workspaceLayers(3), [0, 1, 2]);
  assert.deepEqual(workspaceLayers(12), [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const slots = [];
  const manager = createWorkspaceWindows({ maxOpen: 6, createWindow: (_room, { index }) => { slots.push(index); return { open() {}, close() {}, destroy() {} }; } });
  for (const room of ['a', 'b', 'c', 'd', 'e', 'f']) manager.openRoom(room);
  assert.deepEqual(slots, [0, 1, 2, 3, 4, 5], 'the sixth window does not land on the first');
  manager.closeRoom('b'); manager.openRoom('g');
  assert.equal(slots.at(-1), 1, 'a closed window frees its position');
});

const luminance = hex => { const c = hex.slice(1, 7).match(/../g).map(x => parseInt(x, 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
test('terminal text colors reach 4.5:1 and Korean monospace fonts come first', () => {
  for (const [name, color] of Object.entries(TERMINAL_THEME)) {
    if (/^(background|cursorAccent|selection)/.test(name)) continue;
    assert.ok(contrast(color, TERMINAL_THEME.background) >= 4.5, `${name} ${color}`);
  }
  assert.match(TERMINAL_FONT, /^"D2Coding", "Noto Sans Mono CJK KR"/);
});
