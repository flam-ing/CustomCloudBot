import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolveAgentPresence } from '../public/agent-presence.js';

const source = readFileSync(new URL('../public/agent-presence.js', import.meta.url), 'utf8').replaceAll('export function ', 'function ');
function setup() {
  const makeNode = () => ({ attributes: {}, listeners: new Map(), dataset: {}, children: [], classes: new Set(), setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; if (k === 'src') this.src = null; }, addEventListener(k, fn) { this.listeners.set(k, fn); }, removeEventListener(k) { this.listeners.delete(k); }, append(...nodes) { this.children.push(...nodes); }, replaceChildren() { this.children = []; } });
  const mount = makeNode();
  mount.classList = { toggle(k, on) { if (on) mount.classes.add(k); else mount.classes.delete(k); } };
  const document = { ...makeNode(), hidden: false, createElement(tag) { return { ...makeNode(), tag }; } };
  const motion = { ...makeNode(), matches: false };
  const context = { document, matchMedia: () => motion };
  vm.runInNewContext(`${source}\nthis.createAgentPresence = createAgentPresence;`, context);
  const controller = context.createAgentPresence({ mount });
  return { mount, character: mount.children[0], motion, document, controller };
}

test('completed errors remain visible without overriding a new active request', () => {
  assert.equal(resolveAgentPresence(), 'idle');
  assert.equal(resolveAgentPresence({ hasError: true }), 'error');
  assert.equal(resolveAgentPresence({ rooms: [{ busy: false, stage: 'error' }] }), 'error');
  assert.equal(resolveAgentPresence({ sending: true, hasError: true, rooms: [{ busy: false, stage: 'error' }] }), 'waiting');
  assert.equal(resolveAgentPresence({ rooms: [{ busy: true, stage: 'model' }] }), 'waiting');
  assert.equal(resolveAgentPresence({ rooms: [{ busy: true, stage: 'tool' }] }), 'working');
  assert.equal(resolveAgentPresence({ rooms: [{ busy: true, stage: 'error' }] }), 'error');
});

test('one transparent animation switches state without restarting the same state', () => {
  const app = setup();
  assert.equal(app.character.tag, 'img');
  assert.equal(app.character.src, '/media/agent/idle-poster.webp');
  app.controller.set('idle');
  assert.equal(app.character.src, '/media/agent/idle.webp');
  let writes = 0;
  Object.defineProperty(app.character, 'src', { configurable: true, get() { return '/media/agent/idle.webp'; }, set() { writes++; } });
  app.controller.set('idle');
  assert.equal(writes, 0);
  assert.equal(app.mount.children.length, 2);
  assert.equal(app.mount.attributes['aria-label'], '에이전트 · 쉬고 있어요');
});

test('hidden pages and reduced motion use transparent state posters and restore on return', () => {
  const app = setup();
  app.controller.set('error');
  assert.equal(app.character.src, '/media/agent/error.webp');
  app.document.hidden = true;
  app.document.listeners.get('visibilitychange')();
  assert.equal(app.character.src, '/media/agent/error-poster.webp');
  app.document.hidden = false;
  app.document.listeners.get('visibilitychange')();
  assert.equal(app.character.src, '/media/agent/error.webp');
  app.motion.matches = true;
  app.motion.listeners.get('change')();
  assert.equal(app.character.src, '/media/agent/error-poster.webp');
  app.controller.set('working');
  assert.equal(app.character.src, '/media/agent/working-poster.webp');
  app.controller.reset();
  assert.equal(app.character.src, '/media/agent/idle-poster.webp');
  assert.equal(app.mount.children[1].textContent, '');
});

test('failed animations fall back to a transparent poster and cleanup removes listeners', () => {
  const app = setup();
  app.controller.set('waiting');
  app.character.listeners.get('error')();
  assert.equal(app.character.src, '/media/agent/waiting-poster.webp');
  app.controller.set('waiting');
  assert.equal(app.character.src, '/media/agent/waiting-poster.webp');
  app.controller.destroy();
  assert.equal(app.mount.children.length, 0);
  assert.equal(app.document.listeners.size, 0);
  assert.equal(app.motion.listeners.size, 0);
  assert.equal(app.character.listeners.size, 0);
});
