// Keep message nodes in place across polling. Reattaching an unchanged bubble can
// reset media playback, text selection and the browser's scroll anchor.
const transcripts = new WeakMap();
const PIN_DISTANCE = 48;
const distanceFromBottom = list => list.scrollHeight - list.scrollTop - list.clientHeight;

function signature(message) {
  return JSON.stringify([
    message.kind, message.authorId, message.author, message.text, message.createdAt,
    message.pending, message.error, message.avatarLabel, message.avatarColor, message.avatarUrl,
    (message.attachments || []).map(file => file && [
      file.id, file.kind, file.url, file.name, file.mimeType, file.type, file.size,
      file.width, file.height, file.duration,
    ]),
  ]);
}
function confirms(previous, message) {
  return previous?.pending && (
    (previous.id && previous.id === message.id) ||
    (previous.clientNonceHash && previous.clientNonceHash === message.clientNonceHash)
  );
}
function currentAnchor(list, records) {
  if (typeof list.getBoundingClientRect !== 'function') return null;
  const top = list.getBoundingClientRect().top;
  for (const [key, {node}] of records) {
    if (node.parentNode !== list || typeof node.getBoundingClientRect !== 'function') continue;
    const rect = node.getBoundingClientRect();
    if (rect.bottom > top) return {key, top:rect.top};
  }
  return null;
}
function createState(list, Observer) {
  const state = {roomId:undefined, records:new Map(), nodes:[], observed:new Set(), thinking:null, empty:null, pinned:true, hadMessages:false};
  state.scroll = () => { state.pinned = distanceFromBottom(list) < PIN_DISTANCE; };
  list.addEventListener('scroll', state.scroll, {passive:true});
  if (typeof Observer === 'function') {
    state.observer = new Observer(() => {
      if (list.isConnected === false) { disposeTranscript(list); return; }
      if (state.pinned) list.scrollTop = list.scrollHeight;
    });
    state.observer.observe(list);
  }
  transcripts.set(list, state);
  return state;
}

/**
 * Render an existing main or split transcript without changing its surrounding UI.
 * createMessage(message, {animate}) creates a bubble; updateMessage updates optional
 * external profile information on an unchanged bubble. Call disposeTranscript before
 * removing a list. forceBottom is for a newly submitted local message, not retries or
 * background status updates.
 */
export function renderTranscript(list, messages, {
  roomId, createMessage, updateMessage, busy=false, createThinking, empty,
  forceBottom=false, ResizeObserver: Observer=globalThis.ResizeObserver,
}={}) {
  let state = transcripts.get(list);
  const reset = state?.nodes.length && state.nodes.every(node => node.parentNode !== list);
  const firstPaint = !state || state.roomId !== roomId || reset || (!state.hadMessages && messages.length > 0);
  state ||= createState(list, Observer);
  const roomChanged = state.roomId !== roomId;
  const previous = roomChanged || reset ? new Map() : state.records;
  const oldScroll = list.scrollTop;
  const pinned = firstPaint || forceBottom || distanceFromBottom(list) < PIN_DISTANCE;
  const anchor = pinned ? null : currentAnchor(list, previous);
  const records = new Map(), nodes = [];
  const pending = [...previous.values()].map(record => record.message).filter(message => message.pending);
  for (let index=0; index<messages.length; index++) {
    const message = messages[index];
    let key = message.id || `anonymous:${index}`;
    if (records.has(key)) key = `${key}:${index}`;
    const prior = previous.get(key), nextSignature = signature(message);
    let node = prior?.node;
    if (!prior || prior.signature !== nextSignature) {
      const confirmed = pending.some(item => confirms(item, message));
      node = createMessage(message, {animate:!firstPaint && !prior && !confirmed});
    } else updateMessage?.(node, message);
    records.set(key, {node, signature:nextSignature, message});
    nodes.push(node);
  }
  if (!messages.length && empty) {
    // Empty-state labels can change without any messages changing.
    state.empty = empty();
    if (state.empty) nodes.push(state.empty);
  } else state.empty = null;
  if (busy && createThinking) {
    if (!state.thinking || roomChanged || reset) state.thinking = createThinking();
    if (state.thinking) nodes.push(state.thinking);
  } else state.thinking = null;

  const keep = new Set(nodes);
  for (const node of state.observed) if (!keep.has(node)) {
    state.observer?.unobserve(node);
    state.observed.delete(node);
  }
  for (const child of [...list.children]) if (!keep.has(child)) child.remove();
  let cursor = list.firstElementChild;
  for (const node of nodes) {
    if (node === cursor) { cursor = cursor.nextElementSibling; continue; }
    list.insertBefore(node, cursor);
  }
  state.roomId = roomId;
  state.records = records;
  state.nodes = nodes;
  state.hadMessages = messages.length > 0;
  state.pinned = pinned;
  if (pinned) list.scrollTop = list.scrollHeight;
  else {
    const replacement = anchor && records.get(anchor.key)?.node;
    if (replacement?.parentNode === list && typeof replacement.getBoundingClientRect === 'function') {
      list.scrollTop += replacement.getBoundingClientRect().top - anchor.top;
    } else list.scrollTop = oldScroll;
  }
  for (const node of nodes) if (!state.observed.has(node)) {
    state.observed.add(node);
    state.observer?.observe(node);
  }
}

/** Release observers and listeners before a pane or the workspace is removed. */
export function disposeTranscript(list) {
  const state = transcripts.get(list);
  if (!state) return;
  state.observer?.disconnect();
  list.removeEventListener('scroll', state.scroll);
  state.observed.clear();
  state.records.clear();
  state.nodes = [];
  state.thinking = state.empty = null;
  transcripts.delete(list);
}
