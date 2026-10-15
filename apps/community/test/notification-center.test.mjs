import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationStore, createNotificationCenter, createNotificationFeedState, normalizeNotificationSettings, createNotificationSound, claimNotificationSound } from '../public/notification-center.js';

const roomId = '12345678-1234-4234-8234-123456789012';
const user = (id) => ({ user: { id } });
const message = (id, at, options = {}) => ({ id, createdAt: at, kind: 'bot', text: `answer ${id}`, ...options });
const data = (messages, progress = []) => ({ room: { id: roomId, name: 'Private room' }, messages, progress });

test('initial snapshots and older history do not notify; new replies deduplicate', () => {
  const store = createNotificationStore();
  store.setSession(user('one'));
  store.observeRoom(data([message('old', 10)]), { userId: 'one' });
  assert.equal(store.snapshot().unread, 0);
  const next = data([message('older', 5), message('old', 10), message('self', 12, { kind: 'human', authorId: 'one' }), message('reply', 13)]);
  store.observeRoom(next, { userId: 'one' });
  store.observeRoom(next, { userId: 'one' });
  assert.equal(store.snapshot().unread, 1);
  assert.equal(store.snapshot().items[0].text, 'answer reply');
  store.markRoomRead(roomId);
  assert.equal(store.snapshot().unread, 0);
});

test('logout and account switches clear private data and reject stale responses', () => {
  const store = createNotificationStore();
  store.setSession(user('one'));
  store.observeRoom(data([]), { userId: 'one' });
  store.observeRoom(data([message('new', 1)]), { userId: 'one' });
  store.setSession(user('two'));
  store.observeRoom(data([message('leak', 2)]), { userId: 'one' });
  assert.deepEqual(store.snapshot().items, []);
  store.observeRoom(data([]), { userId: 'two' });
  store.observeRoom(data([message('two', 3)]), { userId: 'two' });
  assert.equal(store.snapshot().unread, 1);
  store.reset();
  assert.deepEqual(store.snapshot(), { userId: null, items: [], unread: 0 });
});

test('progress must have room baseline; history and active steps do not create fake notifications', () => {
  const store = createNotificationStore();
  store.setSession(user('one'));
  const event = { stage: 'error', label: 'Could not complete', at: 10 };
  store.observeProgress(roomId, event, { userId: 'one' });
  store.observeRoom(data([], [event]), { userId: 'one' });
  store.observeProgress(roomId, event, { userId: 'one' });
  store.observeProgress(roomId, { stage: 'thinking', label: 'Working', at: 11 }, { userId: 'one' });
  assert.equal(store.snapshot().unread, 0);
  store.observeProgress(roomId, { ...event, at: 20 }, { userId: 'one' });
  store.observeProgress(roomId, { ...event, at: 20 }, { userId: 'one' });
  store.observeRoom(data([message('system', 21, { kind: 'system' })]), { userId: 'one' });
  assert.equal(store.snapshot().unread, 1);
});

test('bounded history and mark-all; malformed room ids cannot become navigation targets', () => {
  const store = createNotificationStore();
  store.setSession(user('one'));
  store.observeRoom({ room: { id: 'javascript:alert(1)' }, messages: [] }, { userId: 'one' });
  store.observeRoom(data([]), { userId: 'one' });
  store.observeRoom(data(Array.from({ length: 70 }, (_, i) => message(String(i), i + 1))), { userId: 'one' });
  assert.equal(store.snapshot().items.length, 50);
  store.markAllRead();
  assert.equal(store.snapshot().unread, 0);
});

class Element {
  constructor(doc, tag) { this.ownerDocument = doc; this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.handlers = {}; this.scrollTop = 0; this.textContent = ''; this.classList = { add() {} }; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.handlers[k] = fn; }
  removeEventListener(k) { delete this.handlers[k]; }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
}
function makeDocument() {
  const listeners = new Map();
  return { handlers: {}, hidden: false, focused: true, hasFocus() { return this.focused; }, createElement(tag) { return new Element(this, tag); }, createElementNS(_ns, tag) { return this.createElement(tag); }, addEventListener(k, fn) { if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k).add(fn); this.handlers[k] = (event) => [...listeners.get(k)].forEach((handler) => handler(event)); }, removeEventListener(k, fn) { listeners.get(k)?.delete(fn); if (!listeners.get(k)?.size) delete this.handlers[k]; } };
}

test('popup supports Escape and removes rendered private previews on logout', () => {
  const doc = makeDocument();
  const mount = doc.createElement('div');
  const ui = createNotificationCenter({ mount, openRoom: async () => {} });
  ui.setSession(user('one'));
  ui.observeRoom(data([]), { userId: 'one' });
  ui.observeRoom(data([message('new', 1)]), { userId: 'one' });
  const [bell, panel] = mount.children;
  bell.handlers.click();
  assert.equal(panel.hidden, false);
  assert.equal(panel.children[3].children.length, 1);
  doc.handlers.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, bell);
  ui.reset();
  assert.equal(panel.children[3].children.length, 0);
  assert.equal(mount.hidden, true);
  ui.destroy();
  assert.equal(Object.keys(doc.handlers).length, 0);
});


const notice = (sequence, extra = {}) => ({ id: `message:${roomId}:${sequence}`, sequence, roomId, roomName: 'Room', kind: 'bot', title: '새 답변', at: sequence * 100, read: false, ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const find = (node, predicate) => predicate(node) ? node : node.children.map((child) => find(child, predicate)).find(Boolean);

test('feed silently baselines history and never replays read, disabled or viewed events', () => {
  const feed = createNotificationFeedState();
  assert.equal(feed.cursor, null);
  assert.equal(feed.consume({ items: [notice(1)], cursor: 1 }, { soundEnabled: true }).sound.length, 0);
  assert.equal(feed.consume({ items: [notice(1), notice(2)], cursor: 2 }, { soundEnabled: true }).sound.length, 1);
  assert.equal(feed.consume({ items: [notice(2)], cursor: 2 }, { soundEnabled: true }).sound.length, 0);
  assert.equal(feed.consume({ items: [notice(3, { read: true })], cursor: 3 }, { soundEnabled: true }).sound.length, 0);
  assert.equal(feed.consume({ items: [notice(4)], cursor: 4 }, { soundEnabled: false }).sound.length, 0);
  assert.equal(feed.consume({ items: [notice(4)], cursor: 4 }, { soundEnabled: true }).sound.length, 0);
  const viewed = feed.consume({ items: [notice(5)], cursor: 5 }, { soundEnabled: true, viewingRoomIds: [roomId] });
  assert.equal(viewed.sound.length, 0);
  assert.deepEqual(viewed.readIds, [notice(5).id]);
  assert.equal(feed.consume({ items: [notice(5)], cursor: 5 }, { soundEnabled: true }).sound.length, 0);
  feed.reset();
  assert.equal(feed.cursor, null);
  assert.equal(feed.consume({ items: [notice(6)], cursor: 6 }, { soundEnabled: true }).sound.length, 0);
});

test('feed strips private text, rejects invalid navigation, and keeps a monotonic cursor', () => {
  const feed = createNotificationFeedState();
  const result = feed.consume({ items: [notice(2, { text: 'not part of feed', roomName: '  Room  title ' }), notice(3, { roomId: 'javascript:bad' }), notice(-1)] });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].roomName, 'Room title');
  assert.equal(result.entries[0].text, undefined);
  feed.consume({ items: [], cursor: 1 });
  assert.equal(feed.cursor, 2);
});

test('server feed merges read status without replacing detailed room previews', () => {
  const store = createNotificationStore();
  store.setSession(user('one'));
  store.observeRoom(data([]), { userId: 'one' });
  store.observeRoom(data([message('1', 100)]), { userId: 'one' });
  store.ingestFeed([notice(1, { read: true })], { userId: 'one' });
  assert.equal(store.snapshot().items.length, 1);
  assert.equal(store.snapshot().items[0].text, 'answer 1');
  assert.equal(store.snapshot().unread, 0);
  store.ingestFeed([notice(2)], { userId: 'other' });
  assert.equal(store.snapshot().items.length, 1);
});

test('sound claims coordinate tabs, retain only IDs, and do not consume blocked audio', async () => {
  const values = new Map();
  const win = { localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) }, navigator: { locks: { request: async (_key, _options, callback) => callback({}) } } };
  let played = 0;
  const request = { win, userId: 'one', ids: ['event1'], now: 1000, play: () => { played++; return true; } };
  assert.equal(await claimNotificationSound({ ...request, play: () => false }), false);
  assert.equal(values.size, 0);
  assert.equal(await claimNotificationSound(request), true);
  assert.equal(await claimNotificationSound(request), false);
  assert.equal(played, 1);
  assert.deepEqual(JSON.parse(values.get('ccb:notification-sound:one')), { at: 1000, ids: ['event1'] });
  assert.equal(await claimNotificationSound({ ...request, userId: 'two' }), true);
  assert.equal(await claimNotificationSound({ ...request, now: 400000 }), true);
});

test('sound creates audio only on gesture unlock and cleans it on account reset', async () => {
  let created = 0; let closed = 0; let tones = 0;
  class AudioContext {
    constructor() { created++; this.state = 'suspended'; this.sampleRate = 48000; this.currentTime = 0; this.destination = {}; }
    async resume() { this.state = 'running'; }
    async close() { closed++; this.state = 'closed'; }
    createBuffer() { return {}; }
    createBufferSource() { return { connect() {}, start() {} }; }
    createOscillator() { tones++; return { frequency: {}, connect() {}, start() {}, stop() {}, disconnect() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  }
  const sound = createNotificationSound({ AudioContext });
  assert.equal(created, 0);
  assert.equal(sound.play(), false);
  assert.equal(await sound.unlock(), true);
  assert.equal(created, 1);
  assert.equal(sound.play(), true);
  assert.equal(tones, 2);
  sound.reset();
  assert.equal(closed, 1);
  assert.equal(sound.ready, false);
  sound.destroy();
  assert.equal(await sound.unlock(), false);
});

test('settings toggles persist, email is opt in, and unsafe arbitrary destinations are never sent', async () => {
  const doc = makeDocument(); const mount = doc.createElement('div');
  let saved = normalizeNotificationSettings({ emailConfigured: true, emailAddress: 'owner@example.test' });
  const writes = [];
  const api = async (path, options) => {
    if (path === '/api/notifications/settings') {
      if (options) { writes.push(JSON.parse(options.body)); saved = { ...saved, ...JSON.parse(options.body) }; }
      return saved;
    }
    return { items: [], cursor: 0 };
  };
  const ui = createNotificationCenter({ mount, api, openRoom: async () => {} });
  ui.setSession(user('one')); await tick(); ui.openSettings(); await tick();
  const sound = find(mount, (node) => node.attrs['aria-label'] === '앱 알림 소리');
  const email = find(mount, (node) => node.attrs['aria-label'] === '이메일 알림');
  assert.equal(sound.attrs['aria-checked'], 'true');
  assert.equal(email.attrs['aria-checked'], 'false');
  assert.equal(email.disabled, false);
  sound.handlers.click(); await tick();
  email.handlers.click(); await tick();
  assert.deepEqual(writes, [{ soundEnabled: false }, { emailEnabled: true }]);
  assert.equal(sound.attrs['aria-checked'], 'false');
  assert.equal(email.attrs['aria-checked'], 'true');
  ui.destroy();
});

test('missing email mapping disables email and a failed save does not fake enabled state', async () => {
  const doc = makeDocument(); const mount = doc.createElement('div'); const toasts = [];
  let configured = false;
  const api = async (path, options) => {
    if (path === '/api/notifications/settings') {
      if (options) throw Object.assign(new Error('mapping missing'), { status: 409 });
      return { soundEnabled: true, emailEnabled: false, emailConfigured: configured, emailAddress: '' };
    }
    return { items: [], cursor: 0 };
  };
  const ui = createNotificationCenter({ mount, api, openRoom: async () => {}, toast: (text) => toasts.push(text) });
  ui.setSession(user('one')); await tick(); ui.openSettings(); await tick();
  const email = find(mount, (node) => node.attrs['aria-label'] === '이메일 알림');
  assert.equal(email.disabled, true);
  configured = true; ui.openSettings(); await tick();
  email.handlers.click(); await tick();
  assert.equal(email.attrs['aria-checked'], 'false');
  assert.equal(toasts.length, 1);
  ui.destroy();
});

test('focused room feed is acknowledged, while unfocused and stale account responses are not', async () => {
  const doc = makeDocument(); const mount = doc.createElement('div'); const reads = [];
  let resolveFeed;
  const api = async (path, options) => {
    if (path === '/api/notifications/settings') return { soundEnabled: true };
    if (path === '/api/notifications/read') { reads.push(JSON.parse(options.body)); return { read: 1 }; }
    return new Promise((resolve) => { resolveFeed = resolve; });
  };
  const ui = createNotificationCenter({ mount, api, getViewingRoomIds: () => [roomId], openRoom: async () => {} });
  ui.setSession(user('one')); await tick();
  resolveFeed({ items: [notice(1)], cursor: 1 }); await tick();
  assert.deepEqual(reads, [{ ids: [notice(1).id] }]);
  doc.focused = false;
  doc.handlers.visibilitychange({}); await tick();
  resolveFeed({ items: [notice(2)], cursor: 2 }); await tick();
  assert.equal(reads.length, 1);
  doc.handlers.visibilitychange({}); await tick();
  const oldResolve = resolveFeed;
  ui.setSession(user('two')); await tick();
  oldResolve({ items: [notice(3)], cursor: 3 }); await tick();
  assert.equal(reads.length, 1);
  ui.reset();
  resolveFeed({ items: [notice(4)], cursor: 4 }); await tick();
  assert.equal(mount.hidden, true);
  assert.equal(reads.length, 1);
  ui.destroy();
});

test('read acknowledgements retry after network failure, and hidden selection never marks read', async () => {
  const doc = makeDocument(); const mount = doc.createElement('div');
  let attempts = 0; let feedCalls = 0;
  const api = async (path) => {
    if (path === '/api/notifications/settings') return { soundEnabled: true };
    if (path === '/api/notifications/read') { if (++attempts === 1) throw new Error('offline'); return { read: 1 }; }
    return { items: ++feedCalls === 1 ? [notice(1)] : [], cursor: 1 };
  };
  const ui = createNotificationCenter({ mount, api, getViewingRoomIds: () => [roomId], openRoom: async () => {} });
  ui.setSession(user('one')); await tick();
  assert.equal(attempts, 1);
  doc.handlers.visibilitychange({}); await tick();
  assert.equal(attempts, 2);
  doc.hidden = true;
  ui.markRoomRead(roomId); await tick();
  assert.equal(attempts, 2);
  ui.destroy();
});

test('a slow settings read cannot overwrite a successful toggle save', async () => {
  const doc = makeDocument(); const mount = doc.createElement('div');
  let resolveOld; let reads = 0;
  const api = async (path, options) => {
    if (path === '/api/notifications/settings') {
      if (options) return { soundEnabled: false, emailEnabled: false };
      if (++reads === 1) return { soundEnabled: true, emailEnabled: false };
      return new Promise((resolve) => { resolveOld = resolve; });
    }
    return { items: [], cursor: 0 };
  };
  const ui = createNotificationCenter({ mount, api, openRoom: async () => {} });
  ui.setSession(user('one')); await tick();
  ui.openSettings(); await tick();
  const sound = find(mount, (node) => node.attrs['aria-label'] === '앱 알림 소리');
  sound.handlers.click(); await tick();
  assert.equal(sound.attrs['aria-checked'], 'false');
  resolveOld({ soundEnabled: true }); await tick();
  assert.equal(sound.attrs['aria-checked'], 'false');
  ui.destroy();
});

test('large acknowledgement backlogs are sent in batches of at most 200', async () => {
  const doc = makeDocument(); const mount = doc.createElement('div'); const sizes = [];
  const api = async (path, options) => {
    if (path === '/api/notifications/settings') return {};
    if (path === '/api/notifications/read') { sizes.push(JSON.parse(options.body).ids.length); return { read: 200 }; }
    return { items: Array.from({ length: 250 }, (_, index) => notice(index + 1)), cursor: 250 };
  };
  const ui = createNotificationCenter({ mount, api, getViewingRoomIds: () => [roomId], openRoom: async () => {} });
  ui.setSession(user('one')); await tick();
  assert.deepEqual(sizes, [200, 50]);
  ui.destroy();
});

test('opening the bell silently reconciles read markers from another tab', async () => {
  const doc = makeDocument(); const mount = doc.createElement('div'); let initial = true;
  const api = async (path) => {
    if (path === '/api/notifications/settings') return {};
    if (path.includes('?after=')) return { items: [], cursor: 1 };
    const value = { items: [notice(1, { read: !initial })], cursor: 1 };
    initial = false;
    return value;
  };
  const ui = createNotificationCenter({ mount, api, openRoom: async () => {} });
  ui.setSession(user('one')); await tick();
  const bell = mount.children[0];
  assert.equal(bell.attrs['aria-label'], '알림, 읽지 않은 알림 1개');
  bell.handlers.click(); await tick();
  assert.equal(bell.attrs['aria-label'], '알림');
  ui.destroy();
});

test('cross-tab settings invalidation is account-scoped and its listener is removed', async () => {
  const doc = makeDocument(); const mount = doc.createElement('div');
  const win = { handlers: {}, addEventListener(type, callback) { this.handlers[type] = callback; }, removeEventListener(type) { delete this.handlers[type]; }, setInterval() { return 1; }, clearInterval() {} };
  doc.defaultView = win;
  let enabled = true; let reads = 0;
  const api = async (path) => {
    if (path === '/api/notifications/settings') { reads++; return { soundEnabled: enabled }; }
    return { items: [], cursor: 0 };
  };
  const ui = createNotificationCenter({ mount, api, openRoom: async () => {} });
  ui.setSession(user('one')); await tick();
  const sound = find(mount, (node) => node.attrs['aria-label'] === '앱 알림 소리');
  enabled = false;
  win.handlers.storage({ key: 'ccb:notification-settings:other' }); await tick();
  assert.equal(reads, 1);
  win.handlers.storage({ key: 'ccb:notification-settings:one' }); await tick();
  assert.equal(sound.attrs['aria-checked'], 'false');
  assert.equal(reads, 2);
  ui.destroy();
  assert.equal(win.handlers.storage, undefined);
});
