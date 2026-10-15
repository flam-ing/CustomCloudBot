const roomPattern = /^[a-f0-9-]{36}$/i;
const clean = (value, max = 180) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

// Intentionally memory-only: account changes and logout discard private previews.
export function createNotificationStore() {
  let userId = null;
  let items = [];
  const rooms = new Map();
  const matches = (options) => Boolean(userId && options?.userId === userId);
  const add = (item) => {
    const existing = items.find((entry) => entry.id === item.id);
    if (existing) {
      if (existing.generic) { Object.assign(existing, item, { generic: false }); return true; }
      return false;
    }
    items = [{ ...item, read: false }, ...items].slice(0, 50);
    return true;
  };
  const progress = (roomId, event, options) => {
    const room = rooms.get(roomId);
    if (!matches(options) || !room || !Number.isFinite(event?.at)) return false;
    const key = `${event.stage}:${event.at}:${clean(event.label)}`;
    if (room.progress.has(key)) return false;
    room.progress.add(key);
    if (room.progress.size > 100) room.progress.delete(room.progress.values().next().value);
    const old = event.at < room.progressAt;
    room.progressAt = Math.max(room.progressAt, event.at);
    if (old || event.stage !== "error") return false;
    if (items.some((item) => item.roomId === roomId && item.kind === "system" && Math.abs(item.at - event.at) < 5000)) return false;
    return add({ id: `progress:${roomId}:${event.at}`, roomId, roomName: room.name, kind: "error", title: "작업을 완료하지 못했어요", text: clean(event.label) || "대화에서 작업 상태를 확인해주세요.", at: event.at });
  };
  return {
    setSession(session) {
      const nextId = session?.user?.id || null;
      if (nextId === userId) return;
      userId = nextId;
      items = [];
      rooms.clear();
    },
    reset() { userId = null; items = []; rooms.clear(); },
    snapshot() { return { userId, items: items.map((item) => ({ ...item })), unread: items.filter((item) => !item.read).length }; },
    markAllRead() { items.forEach((item) => { item.read = true; }); },
    ingestFeed(entries, options) {
      if (!matches(options)) return;
      for (const item of entries) {
        const existing = items.find((entry) => entry.id === item.id);
        if (existing) { existing.read = existing.read || item.read; existing.roomName = item.roomName; }
        else items.push({ ...item, generic: true, text: "대화에서 확인해주세요." });
      }
      items.sort((a, b) => b.at - a.at);
      items = items.slice(0, 50);
    },
    markRoomRead(id) { items.forEach((item) => { if (item.roomId === id) item.read = true; }); },
    forgetRoom(id) { rooms.delete(id); items = items.filter((item) => item.roomId !== id); },
    observeProgress: progress,
    observeRoom(data, options) {
      const id = data?.room?.id;
      if (!matches(options) || !roomPattern.test(id || "") || !Array.isArray(data.messages)) return false;
      const messages = data.messages.filter((message) => typeof message.id === "string" && message.id.length <= 120 && Number.isFinite(message.createdAt));
      const events = Array.isArray(data.progress) ? data.progress : [];
      const name = clean(data.room.name, 80) || "대화";
      let room = rooms.get(id);
      if (!room) {
        rooms.set(id, { name, seen: new Set(messages.map((message) => message.id)), at: Math.max(0, ...messages.map((message) => message.createdAt)), progress: new Set(events.map((event) => `${event.stage}:${event.at}:${clean(event.label)}`)), progressAt: Math.max(0, ...events.map((event) => Number(event.at) || 0)) });
        if (rooms.size > 100) rooms.delete(rooms.keys().next().value);
        return false;
      }
      room.name = name;
      let changed = false;
      for (const message of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
        if (room.seen.has(message.id)) continue;
        room.seen.add(message.id);
        if (message.createdAt < room.at) continue;
        room.at = Math.max(room.at, message.createdAt);
        if (!["bot", "human", "system"].includes(message.kind) || (message.kind === "human" && message.authorId === userId)) continue;
        if (message.kind === "system" && items.some((item) => item.roomId === id && item.kind === "error" && Math.abs(item.at - message.createdAt) < 5000)) continue;
        changed = add({ id: `message:${id}:${message.id}`, roomId: id, roomName: name, kind: message.kind, title: message.kind === "bot" ? "답변이 도착했어요" : message.kind === "system" ? "대화 안내" : `${clean(message.author, 40) || "참여자"}님의 새 메시지`, text: clean(message.text) || (message.attachments?.length ? "첨부 파일을 보냈어요." : "새 메시지가 도착했어요."), at: message.createdAt }) || changed;
      }
      if (room.seen.size > 400) room.seen = new Set([...room.seen].slice(-200));
      for (const event of events) changed = progress(id, event, options) || changed;
      return changed;
    },
  };
}

const sanitizeFeedEntries = (data) => (Array.isArray(data?.items) ? data.items : []).filter((item) =>
  typeof item?.id === "string" && item.id.length <= 220 && roomPattern.test(item.roomId || "") &&
  Number.isSafeInteger(item.sequence) && item.sequence > 0 && Number.isFinite(item.at)
).map((item) => ({ id: item.id, sequence: item.sequence, roomId: item.roomId, roomName: clean(item.roomName, 80) || "대화", kind: clean(item.kind, 20), title: clean(item.title) || "새 알림이 도착했어요", at: item.at, read: item.read === true }));

// This cursor is separate from detailed room previews: only the server feed can
// produce sound, and reconnecting or switching accounts never replays history.
export function createNotificationFeedState() {
  let initialized = false;
  let cursor = 0;
  const seen = new Set();
  return {
    get cursor() { return initialized ? cursor : null; },
    reset() { initialized = false; cursor = 0; seen.clear(); },
    consume(data, { soundEnabled = false, viewingRoomIds = [] } = {}) {
      const viewing = new Set(viewingRoomIds);
      const entries = sanitizeFeedEntries(data);
      const sound = entries.filter((item) => initialized && item.sequence > cursor && !seen.has(item.id) && !item.read && soundEnabled && !viewing.has(item.roomId));
      for (const item of entries) seen.add(item.id);
      while (seen.size > 500) seen.delete(seen.values().next().value);
      cursor = Math.max(cursor, Number.isSafeInteger(data?.cursor) ? data.cursor : 0, ...entries.map((item) => item.sequence));
      initialized = true;
      return { entries, sound, readIds: entries.filter((item) => !item.read && viewing.has(item.roomId)).map((item) => item.id) };
    },
  };
}

export function normalizeNotificationSettings(value) {
  return { soundEnabled: value?.soundEnabled !== false, emailEnabled: value?.emailEnabled === true, emailAddress: clean(value?.emailAddress, 254), emailConfigured: value?.emailConfigured === true };
}

export function createNotificationSound(win, onChange = () => {}) {
  let context = null;
  let disposed = false;
  const supported = Boolean(win?.AudioContext || win?.webkitAudioContext);
  return {
    get supported() { return supported; },
    get ready() { return !disposed && context?.state === "running"; },
    async unlock() {
      if (!supported || disposed) return false;
      try {
        if (!context || context.state === "closed") {
          context = new (win.AudioContext || win.webkitAudioContext)();
          context.onstatechange = onChange;
        }
        await context.resume();
        if (disposed || context.state !== "running") return false;
        // A silent buffer played inside the user gesture unlocks audio on iOS.
        const source = context.createBufferSource();
        source.buffer = context.createBuffer(1, 1, context.sampleRate);
        source.connect(context.destination);
        source.start();
        onChange();
        return true;
      } catch { onChange(); return false; }
    },
    play() {
      if (disposed || context?.state !== "running") return false;
      try {
        const now = context.currentTime;
        [660, 880].forEach((frequency, index) => {
          const tone = context.createOscillator();
          const gain = context.createGain();
          const start = now + index * .13;
          tone.type = "sine";
          tone.frequency.value = frequency;
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(.055, start + .018);
          gain.gain.exponentialRampToValueAtTime(.0001, start + .29);
          tone.connect(gain); gain.connect(context.destination);
          tone.onended = () => { tone.disconnect(); gain.disconnect(); };
          tone.start(start); tone.stop(start + .3);
        });
        return true;
      } catch { return false; }
    },
    reset() { const previous = context; context = null; if (previous) { previous.onstatechange = null; previous.close().catch(() => {}); } onChange(); },
    destroy() { disposed = true; this.reset(); },
  };
}

// Store only event IDs and a timestamp, never room names or message previews.
export async function claimNotificationSound({ win, userId, ids, play, now = Date.now() }) {
  if (!ids.length || !userId) return false;
  const key = `ccb:notification-sound:${userId}`;
  const claim = () => {
    let previous = { at: 0, ids: [] };
    try { previous = JSON.parse(win.localStorage.getItem(key)) || previous; } catch {}
    const recent = now - previous.at < 5 * 60_000 && Array.isArray(previous.ids) ? previous.ids : [];
    if (ids.every((id) => recent.includes(id))) return false;
    if (!play()) return false;
    try { win.localStorage.setItem(key, JSON.stringify({ at: now, ids: [...new Set([...recent, ...ids])].slice(-200) })); } catch {}
    return true;
  };
  if (win?.navigator?.locks?.request) {
    try { return await win.navigator.locks.request(key, { ifAvailable: true }, (lock) => lock ? claim() : false); } catch { return false; }
  }
  return claim();
}

export function createNotificationCenter({ mount, openRoom, api, getViewingRoomIds = () => [], toast = () => {} }) {
  const store = createNotificationStore();
  if (!mount) return { ...store, openSettings() {}, destroy() { store.reset(); } };
  const doc = mount.ownerDocument;
  const win = doc.defaultView;
  const feed = createNotificationFeedState();
  let generation = 0;
  let opened = false;
  let view = "feed";
  let lastUnread = 0;
  let preferences = normalizeNotificationSettings();
  let preferencesLoaded = false;
  let preferencesBusy = false;
  let preferencesError = "";
  let settingsRequest = 0;
  let pollBusy = false;
  let destroyed = false;
  let timer = null;
  let lastSoundAt = 0;
  let lastRefreshAt = 0;
  let snapshotBusy = false;
  const pendingReads = new Set();
  const pendingRoomReads = new Set();
  let pendingReadAll = 0;
  let readBusy = false;
  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const button = (className, text) => { const node = element("button", className, text); node.type = "button"; return node; };
  mount.classList.add("notification-center");
  const bell = button("notification-bell");
  bell.id = "notification-bell";
  bell.setAttribute("aria-controls", "notification-panel");
  bell.setAttribute("aria-haspopup", "dialog");
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4");
  svg.append(path);
  const badge = element("span", "notification-badge");
  badge.setAttribute("aria-hidden", "true");
  bell.append(svg, badge);
  const panel = element("section", "notification-panel");
  panel.id = "notification-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "notification-title");
  const header = element("div", "notification-head");
  const title = element("h2", "", "알림");
  title.id = "notification-title";
  const headerActions = element("div", "notification-head-actions");
  const settingsButton = button("notification-settings-link", "설정");
  const closeButton = button("notification-close", "×");
  closeButton.setAttribute("aria-label", "알림 닫기");
  headerActions.append(settingsButton, closeButton);
  header.append(title, headerActions);
  const settings = element("div", "notification-preferences");
  const soundRow = element("div", "notification-preference-row");
  const soundCopy = element("div", "notification-preference-copy");
  soundCopy.append(element("strong", "", "앱 알림 소리"), element("p", "", "보고 있지 않은 대화에 새 알림이 오면 소리를 내요."));
  const soundToggle = button("notification-switch");
  soundToggle.setAttribute("role", "switch");
  soundToggle.setAttribute("aria-label", "앱 알림 소리");
  soundRow.append(soundCopy, soundToggle);
  const soundStatus = element("p", "notification-preference-hint");
  const soundPreview = button("notification-setting-button", "소리 들어보기");
  const emailRow = element("div", "notification-preference-row");
  const emailCopy = element("div", "notification-preference-copy");
  emailCopy.append(element("strong", "", "이메일 알림"));
  const emailDescription = element("p");
  emailCopy.append(emailDescription);
  const emailToggle = button("notification-switch");
  emailToggle.setAttribute("role", "switch");
  emailToggle.setAttribute("aria-label", "이메일 알림");
  emailRow.append(emailCopy, emailToggle);
  const emailHint = element("p", "notification-preference-hint");
  const browserSettings = element("div", "notification-browser-settings");
  browserSettings.append(element("strong", "notification-section-title", "기기·브라우저 알림"));
  const pushActions = element("div", "notification-push-actions");
  const push = button("notification-setting-button", "알림 켜기");
  push.id = "push-button";
  const test = button("notification-setting-button is-hidden", "알림 테스트");
  test.id = "test-push-button";
  const status = element("p", "notification-push-status");
  status.id = "push-status";
  pushActions.append(push, test);
  browserSettings.append(pushActions, status);
  settings.append(soundRow, soundStatus, soundPreview, emailRow, emailHint, browserSettings, element("p", "notification-preference-hint", "소리는 앱이 열려 있을 때 재생돼요. 앱을 닫아도 받으려면 기기·브라우저 알림이나 이메일 알림을 켜주세요."));
  const actions = element("div", "notification-actions");
  const markAll = button("notification-mark-read", "모두 읽음");
  actions.append(element("span", "", "새 답변과 대화 활동"), markAll);
  const list = element("ul", "notification-list");
  list.setAttribute("aria-label", "최근 알림");
  const live = element("span", "notification-sr-only");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  panel.append(header, settings, actions, list);
  mount.replaceChildren(bell, panel, live);
  const sound = createNotificationSound(win, () => renderSettings());
  const current = (epoch) => !destroyed && epoch === generation && Boolean(store.snapshot().userId);
  const viewedRooms = () => doc.hidden || (typeof doc.hasFocus === "function" && !doc.hasFocus()) ? [] : getViewingRoomIds();
  // A top-layer popup escapes the composer's and split pane's glass/overflow.
  const topLayer = typeof panel.showPopover === "function";
  if (topLayer) panel.setAttribute("popover", "manual");
  else if (doc.body) doc.body.append(panel);
  const position = () => {
    if (!opened || !win) return;
    const viewport = win.visualViewport;
    const leftEdge = (viewport?.offsetLeft || 0) + 12;
    const topEdge = (viewport?.offsetTop || 0) + 12;
    const viewportWidth = viewport?.width || win.innerWidth;
    const viewportHeight = viewport?.height || win.innerHeight;
    const width = Math.max(1, Math.min(370, viewportWidth - 24));
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.max(1, viewportHeight - 24)}px`;
    const anchor = bell.getBoundingClientRect();
    const height = panel.getBoundingClientRect().height;
    const bottomEdge = topEdge + viewportHeight - 24;
    const below = anchor.bottom + 10;
    const above = anchor.top - height - 10;
    const top = below + height <= bottomEdge ? below : Math.max(topEdge, above);
    panel.style.left = `${Math.max(leftEdge, Math.min(anchor.right - width, leftEdge + viewportWidth - 24 - width))}px`;
    panel.style.top = `${Math.min(Math.max(topEdge, top), bottomEdge - height)}px`;
  };
  const close = (restoreFocus = false) => {
    opened = false;
    if (topLayer && panel.matches(":popover-open")) panel.hidePopover();
    panel.hidden = true;
    bell.setAttribute("aria-expanded", "false");
    if (restoreFocus) bell.focus();
  };
  const renderSettings = () => {
    settings.hidden = view !== "settings";
    actions.hidden = view === "settings";
    list.hidden = view === "settings";
    title.textContent = view === "settings" ? "알림 설정" : "알림";
    settingsButton.textContent = view === "settings" ? "알림 목록" : "설정";
    soundToggle.setAttribute("aria-checked", String(preferences.soundEnabled));
    emailToggle.setAttribute("aria-checked", String(preferences.emailEnabled));
    soundToggle.disabled = preferencesBusy || !preferencesLoaded;
    emailToggle.disabled = preferencesBusy || !preferencesLoaded || (!preferences.emailConfigured && !preferences.emailEnabled);
    soundPreview.disabled = !sound.supported;
    soundStatus.textContent = preferencesError || (!sound.supported ? "이 브라우저에서는 앱 알림 소리를 지원하지 않아요." : !preferences.soundEnabled ? "소리가 꺼져 있어요." : sound.ready ? "소리가 준비됐어요." : "소리 들어보기를 누르면 이 기기에서 소리를 사용할 수 있어요.");
    emailDescription.textContent = preferences.emailAddress || "알림을 받을 이메일이 아직 연결되지 않았어요.";
    emailHint.textContent = preferences.emailConfigured ? "약 1분 동안 읽지 않은 알림을 보내요. 대화 내용은 포함하지 않아요." : preferences.emailAddress ? "메일 발송 설정이 준비되면 켤 수 있어요." : "관리자가 연결한 본인 이메일이 있어야 켤 수 있어요.";
  };
  const render = () => {
    const snapshot = store.snapshot();
    mount.hidden = !snapshot.userId;
    bell.setAttribute("aria-label", snapshot.unread ? `알림, 읽지 않은 알림 ${snapshot.unread}개` : "알림");
    bell.setAttribute("aria-expanded", String(opened));
    badge.hidden = !snapshot.unread;
    badge.textContent = String(snapshot.unread);
    panel.hidden = !opened;
    markAll.disabled = !snapshot.unread;
    if (snapshot.unread !== lastUnread) live.textContent = snapshot.unread ? `읽지 않은 알림 ${snapshot.unread}개` : "";
    lastUnread = snapshot.unread;
    renderSettings();
    if (!opened) return;
    const focusedId = doc.activeElement?.dataset?.notificationId;
    const scroll = list.scrollTop;
    list.replaceChildren();
    if (!snapshot.items.length) {
      const empty = element("li", "notification-empty");
      empty.append(element("strong", "", "새 알림이 없어요"), element("span", "", "다른 대화의 새 답변과 활동도 여기에 표시돼요."));
      list.append(empty);
    }
    for (const item of snapshot.items) {
      const row = element("li");
      const entry = button(`notification-item${item.read ? "" : " is-unread"}`);
      entry.dataset.notificationId = item.id;
      const meta = element("span", "notification-item-meta");
      const time = element("time", "", new Date(item.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }));
      time.dateTime = new Date(item.at).toISOString();
      meta.append(element("strong", "", item.roomName), time);
      entry.append(meta, element("span", "notification-item-title", item.title), element("span", "notification-item-text", item.text));
      entry.addEventListener("click", async () => {
        const epoch = generation;
        entry.disabled = true;
        try {
          await openRoom(item.roomId);
          if (!current(epoch)) return;
          store.markRoomRead(item.roomId);
          void saveRead({ roomId: item.roomId }, epoch);
          close();
        } catch (error) {
          if (!current(epoch)) return;
          if (error?.status === 403 || error?.status === 404) store.forgetRoom(item.roomId);
          toast("대화를 열지 못했어요. 대화 목록에서 다시 확인해주세요.");
        } finally { if (current(epoch)) render(); }
      });
      row.append(entry);
      list.append(row);
      if (focusedId === item.id) entry.focus({ preventScroll: true });
    }
    list.scrollTop = scroll;
    if (topLayer && !panel.matches(":popover-open")) panel.showPopover();
    position();
  };
  const flushReads = async (epoch) => {
    if (!api || !current(epoch) || readBusy) return;
    readBusy = true;
    try {
      while (current(epoch) && (pendingReadAll || pendingRoomReads.size || pendingReads.size)) {
        const allVersion = pendingReadAll;
        const rooms = [...pendingRoomReads];
        const ids = [...pendingReads].slice(0, 200);
        const payload = allVersion ? { all: true } : rooms.length ? { roomId: rooms[0] } : { ids };
        await api("/api/notifications/read", { method: "POST", body: JSON.stringify(payload) });
        if (!current(epoch)) return;
        if (allVersion) {
          if (pendingReadAll === allVersion) pendingReadAll = 0;
          rooms.forEach((room) => pendingRoomReads.delete(room));
          ids.forEach((id) => pendingReads.delete(id));
        } else if (rooms.length) pendingRoomReads.delete(rooms[0]);
        else ids.forEach((id) => pendingReads.delete(id));
      }
    } catch { /* Keep acknowledgements queued for the next feed/focus poll. */ }
    finally { if (current(epoch)) readBusy = false; }
  };
  const saveRead = async (payload, epoch = generation) => {
    if (!api || !current(epoch)) return;
    if (payload.all) pendingReadAll++;
    if (payload.roomId) pendingRoomReads.add(payload.roomId);
    for (const id of payload.ids || []) pendingReads.add(id);
    await flushReads(epoch);
  };
  const readViewingRooms = async (epoch) => {
    const rooms = new Set(viewedRooms());
    const ids = store.snapshot().items.filter((item) => !item.read && rooms.has(item.roomId)).map((item) => item.id);
    for (const id of ids) pendingReads.add(id);
    for (const roomId of rooms) store.markRoomRead(roomId);
    await flushReads(epoch);
  };
  const loadSettings = async (epoch) => {
    if (!api || !current(epoch) || preferencesBusy) return;
    const request = ++settingsRequest;
    try {
      const value = await api("/api/notifications/settings");
      if (!current(epoch) || preferencesBusy || request !== settingsRequest) return;
      preferences = normalizeNotificationSettings(value);
      preferencesLoaded = true;
      preferencesError = "";
      renderSettings();
    } catch { if (current(epoch) && request === settingsRequest) { preferencesError = "설정을 불러오지 못했어요. 잠시 후 다시 열어주세요."; renderSettings(); } }
  };
  const saveSettings = async (patch) => {
    const epoch = generation;
    if (!api || !current(epoch) || preferencesBusy || !preferencesLoaded) return;
    preferencesBusy = true;
    settingsRequest++;
    renderSettings();
    try {
      const value = await api("/api/notifications/settings", { method: "POST", body: JSON.stringify(patch) });
      if (!current(epoch)) return;
      preferences = normalizeNotificationSettings(value);
      try { win?.localStorage.setItem(`ccb:notification-settings:${store.snapshot().userId}`, String(Date.now())); } catch {}
    } catch (error) {
      if (current(epoch)) toast(error?.status === 409 ? "알림을 받을 이메일 연결을 먼저 확인해주세요." : "알림 설정을 저장하지 못했어요.");
    } finally { if (current(epoch)) { preferencesBusy = false; renderSettings(); } }
  };
  const poll = async () => {
    const epoch = generation;
    if (!api || !current(epoch) || pollBusy) return;
    pollBusy = true;
    try {
      const data = await api(`/api/notifications${feed.cursor === null ? "" : `?after=${feed.cursor}`}`);
      if (!current(epoch)) return;
      const result = feed.consume(data, { soundEnabled: preferencesLoaded && preferences.soundEnabled, viewingRoomIds: viewedRooms() });
      store.ingestFeed(result.entries, { userId: store.snapshot().userId });
      result.readIds.forEach((id) => pendingReads.add(id));
      void readViewingRooms(epoch);
      if (result.sound.length && sound.ready && Date.now() - lastSoundAt > 1500) {
        await claimNotificationSound({ win, userId: store.snapshot().userId, ids: result.sound.map((item) => item.id), play: () => {
          if (!current(epoch) || !preferences.soundEnabled || !result.sound.some((item) => !viewedRooms().includes(item.roomId))) return false;
          const played = sound.play();
          if (played) lastSoundAt = Date.now();
          return played;
        } });
      }
      if (current(epoch)) render();
    } catch { /* Keep the existing feed and retry, without re-baselining. */ }
    finally { if (current(epoch)) pollBusy = false; }
  };
  const refreshSnapshot = async () => {
    const epoch = generation;
    if (!api || !current(epoch) || snapshotBusy || feed.cursor === null) return;
    snapshotBusy = true;
    try {
      const data = await api("/api/notifications");
      if (!current(epoch)) return;
      // Reconcile another tab's read markers, but do not consume the sound cursor.
      store.ingestFeed(sanitizeFeedEntries(data), { userId: store.snapshot().userId });
      void readViewingRooms(epoch);
      render();
    } catch {}
    finally { if (current(epoch)) snapshotBusy = false; }
  };
  const refreshPreferencesAndReads = (force = false) => {
    if (!force && Date.now() - lastRefreshAt < 30_000) return;
    lastRefreshAt = Date.now();
    void loadSettings(generation);
    void refreshSnapshot();
  };
  const openSettings = () => {
    if (!store.snapshot().userId) return;
    opened = true; view = "settings"; render();
    void loadSettings(generation);
    settingsButton.focus();
  };
  const onGesture = (event) => {
    if (event.isTrusted === false || !store.snapshot().userId || !preferences.soundEnabled || sound.ready) return;
    void sound.unlock();
  };
  const onStorage = (event) => {
    const userId = store.snapshot().userId;
    if (userId && event.key === `ccb:notification-settings:${userId}`) void loadSettings(generation);
  };
  const onVisible = () => {
    if (!store.snapshot().userId) return;
    void readViewingRooms(generation);
    if (!doc.hidden) { void poll(); refreshPreferencesAndReads(true); }
  };
  bell.addEventListener("click", () => { if (opened) close(); else { opened = true; view = "feed"; render(); closeButton.focus(); void poll(); refreshPreferencesAndReads(true); } });
  settingsButton.addEventListener("click", () => { view = view === "settings" ? "feed" : "settings"; render(); if (view === "settings") void loadSettings(generation); });
  closeButton.addEventListener("click", () => close(true));
  markAll.addEventListener("click", () => { store.markAllRead(); void saveRead({ all: true }); render(); });
  soundToggle.addEventListener("click", () => { if (!preferences.soundEnabled) void sound.unlock(); void saveSettings({ soundEnabled: !preferences.soundEnabled }); });
  emailToggle.addEventListener("click", () => { void saveSettings({ emailEnabled: !preferences.emailEnabled }); });
  soundPreview.addEventListener("click", async () => { const epoch = generation; if (await sound.unlock() && current(epoch)) sound.play(); });
  const onOutside = (event) => { if (opened && !mount.contains(event.target) && !panel.contains(event.target)) close(); };
  const onKey = (event) => { if (opened && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } };
  doc.addEventListener("pointerdown", onOutside);
  doc.addEventListener("pointerdown", onGesture, true);
  doc.addEventListener("focusin", onOutside);
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("keydown", onGesture, true);
  doc.addEventListener("visibilitychange", onVisible);
  doc.addEventListener("scroll", position, true);
  win?.addEventListener("storage", onStorage);
  win?.addEventListener("focus", onVisible);
  win?.addEventListener("resize", position);
  win?.visualViewport?.addEventListener("resize", position);
  win?.visualViewport?.addEventListener("scroll", position);
  const resizeObserver = win?.ResizeObserver ? new win.ResizeObserver(position) : null;
  resizeObserver?.observe(panel);
  const clearSession = () => {
    generation++;
    if (timer !== null) win?.clearInterval(timer);
    timer = null; pollBusy = false; snapshotBusy = false; preferencesBusy = false; preferencesLoaded = false; lastRefreshAt = 0;
    preferences = normalizeNotificationSettings();
    settingsRequest++; preferencesError = "";
    feed.reset(); pendingReads.clear(); pendingRoomReads.clear(); pendingReadAll = 0; readBusy = false; lastSoundAt = 0;
    close(); list.replaceChildren(); live.textContent = ""; sound.reset();
  };
  render();
  return {
    setSession(session) {
      const before = store.snapshot().userId;
      store.setSession(session);
      if (before !== store.snapshot().userId) {
        clearSession();
        if (store.snapshot().userId && api) {
          lastRefreshAt = Date.now();
          void loadSettings(generation); void poll();
          timer = win?.setInterval(() => { void poll(); refreshPreferencesAndReads(); }, 3000) ?? null;
        }
      }
      render();
    },
    openSettings,
    observeRoom(data, options) { if (store.observeRoom(data, options)) { void readViewingRooms(generation); render(); } },
    observeProgress(id, event, options) { if (store.observeProgress(id, event, options)) { void readViewingRooms(generation); render(); } },
    markRoomRead(id) { if (!viewedRooms().includes(id)) return; store.markRoomRead(id); void saveRead({ roomId: id }); render(); },
    reset() { clearSession(); store.reset(); render(); },
    destroy() {
      clearSession(); destroyed = true; store.reset(); sound.destroy();
      doc.removeEventListener("pointerdown", onOutside); doc.removeEventListener("pointerdown", onGesture, true);
      doc.removeEventListener("focusin", onOutside); doc.removeEventListener("keydown", onKey); doc.removeEventListener("keydown", onGesture, true);
      doc.removeEventListener("visibilitychange", onVisible); doc.removeEventListener("scroll", position, true);
      win?.removeEventListener("storage", onStorage); win?.removeEventListener("focus", onVisible); win?.removeEventListener("resize", position);
      win?.visualViewport?.removeEventListener("resize", position);
      win?.visualViewport?.removeEventListener("scroll", position);
      resizeObserver?.disconnect();
      if (doc.body && panel.parentElement === doc.body) panel.remove();
      mount.replaceChildren();
    },
  };
}
