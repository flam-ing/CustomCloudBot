import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {request as httpRequest} from 'node:http';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';
import {sessionColors} from '../public/session-colors.js';
import {rgbToHex} from '../public/session-color-picker.mjs';

const canonical = 'https://bots.example.test', installed = 'https://192.0.2.10';
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'session-color-picker-'));
  const options = {dataDir, port: 0, env: {COMMUNITY_BOOTSTRAP_TOKEN: 'bootstrap', COMMUNITY_ORIGIN: canonical, COMMUNITY_APP_ORIGIN: installed}};
  let app = await startCommunity(options);
  t.after(async () => { await app.close(); await rm(dataDir, {recursive: true, force: true}); });
  function call(path, {auth, body, host = 'bots.example.test', headers = {}} = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest(new URL(path, app.url), {method: data === undefined ? 'GET' : 'POST', headers: {
        host, ...(data === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin: canonical}),
        ...(auth ? {cookie: auth.cookie, 'x-csrf-token': auth.csrf} : {}), ...headers,
      }}, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString(); let json;
          try { json = JSON.parse(text); } catch {}
          resolve({status: response.statusCode, headers: response.headers, text, data: json});
        });
      });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Test request timed out'))); req.end(data);
    });
  }
  return {call, async restart() { await app.close(); app = await startCommunity(options); }};
}

test('the session color picker module is served as JavaScript for web and installed-app origins', async t => {
  const app = await fixture(t);
  for (const host of ['bots.example.test', '192.0.2.10']) {
    const response = await app.call('/session-color-picker.mjs', {host, headers: {'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script'}});
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /^text\/javascript\b/);
    assert.match(response.text, /export function createSessionColorPicker\(/);
    assert.match(response.text, /export function rgbToHex\(/);
  }
});

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function functionSource(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Application function range ${start}`);
  return source.slice(from, to);
}
function dialogFixture({room, auth, call}) {
  const state = {session: {user: {id: auth.id}}, rooms: [room], forks: [], selectedRoom: room.id, extra: []};
  let dialog, picker, writes = 0, renders = 0;
  const element = (tag, text, className) => ({
    tagName: tag, textContent: text, className, children: [], isConnected: true, classList: {add() {}},
    append(...children) { this.children.push(...children); }, setAttribute() {}, showModal() {}, close() { this.isConnected = false; },
  });
  const runtime = {
    state, sidebarEpoch: 1, MONITOR_ROOM: 'monitor', sessionColors, rgbToHex,
    contextElement: element, sidebarDialog: () => (dialog = element('dialog')), paintSession() {},
    // Component behavior is covered separately. Here its draft/validity contract
    // drives the real dialog save boundary and real authenticated preferences API.
    createSessionColorPicker(options) {
      picker = {initial: options.value, valid: true, element: element('div'),
        choose(color) { options.onChange(color); }, reportValidity() { return this.valid; }};
      return picker;
    },
    api: async (path, options) => {
      writes++;
      const response = await call(path, {auth, body: JSON.parse(options.body)});
      assert.equal(response.status, 200); return response.data;
    },
    renderRooms() { renders++; }, toast(message) { throw new Error(message); },
  };
  vm.runInNewContext(
    functionSource('async function updateRoomListPreference(', 'function sidebarRoomButton(') +
    functionSource('function openSessionColor(', 'function openSessionActions('), runtime,
  );
  return {
    runtime, state, get picker() { return picker; }, get writes() { return writes; }, get renders() { return renders; },
    open() { runtime.openSessionColor(room.id); },
    action(label) { return dialog.children.flatMap(node => node.children).find(node => node.textContent === label).onclick(); },
  };
}

test('picking and cancelling stays local; saving an arbitrary RGB color persists and automatic reset stores null', async t => {
  const app = await fixture(t);
  const registration = await app.call('/api/register', {body: {username: 'color_picker_owner', displayName: 'Picker owner', password: 'color-picker-test-password', inviteToken: 'bootstrap'}});
  assert.equal(registration.status, 201);
  const auth = {id: registration.data.user.id, csrf: registration.data.csrfToken, cookie: registration.headers['set-cookie'][0].split(';')[0]};
  const created = await app.call('/api/rooms', {auth, body: {name: 'Color picker test'}});
  assert.equal(created.status, 201);
  const path = `/api/rooms/${created.data.room.id}`;
  assert.equal((await app.call(path + '/preferences', {auth, body: {pinned: true, color: '#9064c2'}})).status, 200);
  const readRoom = async () => (await app.call(path, {auth})).data.room;
  const ui = dialogFixture({room: await readRoom(), auth, call: app.call});

  ui.open(); ui.picker.choose('#12abef');
  assert.equal((await readRoom()).color, '#9064c2');
  assert.equal(ui.state.rooms[0].color, '#9064c2');
  ui.action('취소');
  assert.equal(ui.writes, 0);
  assert.equal((await readRoom()).color, '#9064c2');

  ui.open(); assert.equal(ui.picker.initial, '#9064c2'); ui.picker.choose('#12abef');
  ui.picker.valid = false; await ui.action('저장');
  assert.equal(ui.writes, 0, 'invalid drafts never reach the preferences API');
  ui.picker.valid = true; await ui.action('저장');
  assert.equal(ui.writes, 1); assert.equal(ui.renders, 1);
  assert.equal(ui.state.rooms[0].color, '#12abef');
  await app.restart();
  const stored = await readRoom();
  assert.equal(stored.color, '#12abef'); assert.equal(stored.pinned, true);
  assert.equal((await app.call('/api/rooms', {auth})).data.rooms.find(room => room.id === stored.id).color, '#12abef');

  ui.open(); assert.equal(ui.picker.initial, '#12abef'); ui.picker.choose(null); await ui.action('저장');
  assert.equal((await readRoom()).color, null);
  assert.equal((await readRoom()).pinned, true);
  ui.open(); ui.picker.choose('#ffffff'); ui.runtime.sidebarEpoch++; await ui.action('저장');
  assert.equal(ui.writes, 2, 'a dialog from an expired workspace generation cannot save');
  assert.equal((await readRoom()).color, null);
});
