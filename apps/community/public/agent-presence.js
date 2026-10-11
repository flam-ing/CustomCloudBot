const STATES = { idle: '쉬고 있어요', working: '작업 중', waiting: '응답을 기다리고 있어요', error: '작업을 확인해 주세요' };
export function resolveAgentPresence({ sending = false, rooms = [], hasError = false } = {}) {
  const busy = rooms.filter(room => room.busy);
  if (busy.some(room => room.stage === 'error')) return 'error';
  if (busy.some(room => !['accepted', 'model', 'queued', 'waiting'].includes(room.stage))) return 'working';
  if (busy.length || sending) return 'waiting';
  // Finishing a failed request must not immediately replace its error pose with idle.
  return hasError || rooms.some(room => room.stage === 'error') ? 'error' : 'idle';
}
export function createAgentPresence({ mount, poster = '/media/agent/idle-poster.webp' }) {
  // Animated WebP retains the supplied videos' motion and alpha across browsers.
  // The matte is removed once when preparing the assets, never per browser frame.
  const character = document.createElement('img');
  character.className = 'agent-presence-image'; character.alt = ''; character.decoding = 'async';
  character.setAttribute('aria-hidden', 'true'); character.draggable = false;
  const label = document.createElement('span'); label.className = 'sr-only'; label.setAttribute('role', 'status');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let active = false, state = 'idle', source = null;
  const failedSources = new Set();
  mount.append(character, label); mount.dataset.state = state;
  function playback() {
    const animate = active && !document.hidden && !motion.matches;
    const still = `/media/agent/${state}-poster.webp`;
    const candidates = animate ? [`/media/agent/${state}.webp`, still, poster] : [still, poster];
    const next = candidates.find(path => !failedSources.has(path)) || poster;
    mount.classList.toggle('is-paused', !animate);
    if (source !== next) { source = next; character.src = next; }
  }
  function set(next = 'idle', visible = true) {
    active = visible; state = Object.hasOwn(STATES, next) ? next : 'idle';
    mount.dataset.state = state; label.textContent = active ? STATES[state] : '';
    mount.setAttribute('aria-label', active ? `에이전트 · ${STATES[state]}` : '에이전트');
    playback();
  }
  function mediaError() {
    failedSources.add(source);
    playback();
  }
  character.addEventListener('error', mediaError);
  document.addEventListener('visibilitychange', playback);
  motion.addEventListener?.('change', playback);
  playback();
  return { set, reset: () => set('idle', false), destroy() { active = false; character.removeEventListener('error', mediaError); character.removeAttribute('src'); document.removeEventListener('visibilitychange', playback); motion.removeEventListener?.('change', playback); mount.replaceChildren(); } };
}
