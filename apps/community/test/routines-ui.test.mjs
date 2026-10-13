import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {validateRoutineSchedule, routineStatusLabel, routineReasonLabel, routineScheduleLabel} from '../public/routines.js';

const source = readFileSync(new URL('../public/routines.js', import.meta.url), 'utf8').replaceAll('export function ', 'function ');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
function setup(apiResult = async () => ({routines: []})) {
  let document;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.attributes = {}; this._value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.checked = false; this.isConnected = true; }
    set value(value) { this._value = String(value); } get value() { return this._value; }
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); if (this.tagName === 'select' && !this.value) this.value = item.value; } }
    replaceChildren(...items) { for (const item of this.children) item.isConnected = false; this.children = []; this.append(...items); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, action) { this.handlers[name] = action; }
    querySelectorAll(selector) { const matches = selector.split(',').map(v => v.trim()); return this.children.flatMap(child => [...(matches.some(match => match === child.tagName || (match === '[data-confirm-delete]' && child.dataset.confirmDelete)) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    showModal() { this.open = true; } close() { this.open = false; }
    focus() { if (!this.disabled) document.activeElement = this; }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
    reset() { for (const field of this.querySelectorAll('input, textarea, select')) { field.value = ''; field.checked = false; } }
  }
  document = {body: new Element('body'), activeElement: new Element('button'), createElement: tag => new Element(tag)};
  let userId = 'one', room = {id: 'room-1', name: '테스트 대화'}, nonce = 0;
  const calls = [], changes = [], timers = new Map();
  const context = {document, Intl, Date, Map, Set, Promise, crypto: {randomUUID: () => `nonce-${++nonce}`}, setTimeout: action => { const id = timers.size + 1; timers.set(id, action); return id; }, clearTimeout: id => timers.delete(id)};
  vm.runInNewContext(source + '\nthis.createRoutineUI = createRoutineUI;', context);
  const ui = context.createRoutineUI({api: async (path, options) => {calls.push({path, options}); return apiResult(path, options);}, getSession: () => userId ? {user: {id: userId}} : null, getRoom: () => room, onChanged: change => changes.push(change)});
  const nodes = () => document.body.querySelectorAll('button, input, select, textarea, form, p, dialog, section');
  return {ui, calls, changes, timers, document, open(defaults) { ui.open(room, defaults); }, setUser(value) {userId = value;}, setRoom(value) {room = value;}, find(predicate) {return nodes().find(predicate);}, field(name) {return nodes().find(item => item.name === name);}, btn(text) {return nodes().find(item => item.tagName === 'button' && item.textContent === text);}, click(text) {const item = this.btn(text); assert.ok(item, text); assert.equal(item.disabled, false, text); return item.handlers.click();}, submit() {return this.find(item => item.tagName === 'form').handlers.submit({preventDefault() {}});}, text() { const walk = item => [item.textContent, ...item.children.flatMap(walk)]; return walk(document.body).join(' '); }};
}
const routine = {id: 'routine-1', roomId: 'room-1', title: '아침 정리', prompt: '오늘 할 일 알려줘', enabled: false, model: 'saved-model', effort: 'high', schedule: {type: 'weekly', time: '08:30', timezone: 'Asia/Seoul', daysOfWeek: [1, 5]}, lastStatus: 'submitted', lastRunAt: 1791846000000};

test('schedule validates daily/weekly/timezone and uses Monday=1 through Sunday=7', () => {
  assert.deepEqual(validateRoutineSchedule({type: 'weekly', time: '09:30', timezone: 'Asia/Seoul', daysOfWeek: [7, 1, 1]}), {type: 'weekly', time: '09:30', timezone: 'Asia/Seoul', daysOfWeek: [1, 7]});
  assert.throws(() => validateRoutineSchedule({type: 'weekly', time: '09:30', timezone: 'Asia/Seoul', daysOfWeek: []}), /요일/);
  assert.throws(() => validateRoutineSchedule({type: 'daily', time: '29:30', timezone: 'Asia/Seoul'}), /시간/);
  assert.throws(() => validateRoutineSchedule({type: 'daily', time: '09:30', timezone: 'not-a-zone'}), /시간대/);
  for (const everyMinutes of [4, 10081, 5.5]) assert.throws(() => validateRoutineSchedule({type: 'interval', everyMinutes}), /5~10080/);
  assert.deepEqual(validateRoutineSchedule({type: 'interval', everyMinutes: 5}), {type: 'interval', everyMinutes: 5, timezone: 'Asia/Seoul'});
  assert.match(routineScheduleLabel(routine.schedule), /월·금 08:30/);
});

test('last status describes dispatch, never AI completion, and unknown reason data is not displayed', () => {
  assert.equal(routineStatusLabel('submitted'), '대화에 보냄');
  assert.match(routineReasonLabel('room_busy'), /현재 작업/);
  assert.equal(routineReasonLabel('raw private server error'), '');
});

test('open is read-only and new routine is explicitly paused with selected model defaults', async () => {
  const app = setup(async (path, options) => options ? {routine: {...routine, ...JSON.parse(options.body)}} : {routines: []});
  app.open({model: 'chosen-model', effort: 'medium'}); await tick();
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].options, undefined);
  app.click('+ 새 루틴');
  assert.equal(app.field('enabled').checked, false); assert.equal(app.field('timezone').value, 'Asia/Seoul');
  app.field('prompt').value = '매일 정리해 줘'; app.field('title').value = '정리';
  app.submit(); await tick();
  const call = app.calls.at(-1), payload = JSON.parse(call.options.body);
  assert.equal(call.path, '/api/rooms/room-1/routines'); assert.equal(call.options.method, 'POST');
  assert.deepEqual(payload, {title: '정리', prompt: '매일 정리해 줘', enabled: false, schedule: {type: 'daily', time: '09:00', timezone: 'Asia/Seoul'}, model: 'chosen-model', effort: 'medium'});
  assert.equal(app.calls.some(call => call.path.endsWith('/run')), false);
  assert.equal(app.changes[0].action, 'save'); assert.equal(app.document.activeElement, app.btn('+ 새 루틴'));
  app.ui.destroy(); assert.equal(app.timers.size, 0);
});

test('edit keeps saved model, effort and weekdays even when current model differs', async () => {
  const app = setup(async (path, options) => options ? {routine: {...routine, ...JSON.parse(options.body)}} : {routines: [routine]});
  app.open({model: 'different-model', effort: 'low'}); await tick(); app.click('수정'); app.field('prompt').value = '수정한 메시지'; app.submit(); await tick();
  const call = app.calls.at(-1), payload = JSON.parse(call.options.body);
  assert.equal(call.path, '/api/routines/routine-1'); assert.equal(call.options.method, 'PATCH');
  assert.equal(payload.model, 'saved-model'); assert.equal(payload.effort, 'high'); assert.deepEqual(payload.schedule.daysOfWeek, [1, 5]);
  app.ui.destroy();
});

test('failed save keeps entered prompt and manual run retries share the same nonce', async () => {
  let attempts = 0;
  const app = setup(async (path, options) => {
    if (!options) return {routines: [routine]};
    if (path.endsWith('/run')) { if (++attempts === 1) throw new Error('연결이 끊겼습니다.'); return {routine: {...routine, lastStatus: 'queued'}}; }
    throw new Error('저장하지 못했습니다.');
  });
  app.open(); await tick(); app.click('수정'); app.field('prompt').value = '보존할 입력'; app.submit(); await tick();
  assert.equal(app.field('prompt').value, '보존할 입력'); assert.match(app.text(), /저장하지 못했습니다/);
  app.click('취소'); app.click('지금 실행'); await tick(); app.click('지금 실행'); await tick();
  const runs = app.calls.filter(call => call.path.endsWith('/run'));
  assert.equal(runs.length, 2); assert.equal(JSON.parse(runs[0].options.body).requestId, JSON.parse(runs[1].options.body).requestId);
  app.click('지금 실행'); await tick();
  assert.notEqual(JSON.parse(app.calls.at(-1).options.body).requestId, JSON.parse(runs[0].options.body).requestId);
  app.ui.destroy();
});

test('account/room changes and closed dialogs discard late reads and mutations', async () => {
  for (const stale of ['user', 'room', 'close']) {
    const response = deferred(), app = setup(() => response.promise);
    app.open();
    if (stale === 'user') app.setUser('two'); else if (stale === 'room') app.setRoom({id: 'room-2'}); else app.ui.close();
    response.resolve({routines: [routine]}); await tick();
    assert.doesNotMatch(app.text(), /오늘 할 일 알려줘/); assert.equal(app.changes.length, 0); assert.equal(app.timers.size, 0); app.ui.destroy();
  }
  const pending = deferred(), app = setup(async (path, options) => options ? pending.promise : {routines: [routine]});
  app.open(); await tick(); app.click('예약 켜기'); app.setUser('two'); pending.resolve({routine: {...routine, enabled: true}}); await tick();
  assert.equal(app.changes.length, 0); assert.equal(app.timers.size, 0); assert.equal(app.find(item => item.tagName === 'dialog').open, false); app.ui.destroy();
});

test('pause and deletion need explicit actions; deletion leaves conversation API untouched', async () => {
  const app = setup(async (path, options) => options?.method === 'DELETE' ? {deleted: true} : options ? {routine: {...routine, enabled: true}} : {routines: [routine]});
  app.open(); await tick(); app.click('예약 켜기'); await tick(); assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), {enabled: true});
  app.click('삭제'); assert.notEqual(app.calls.at(-1).options.method, 'DELETE');
  app.click('루틴 삭제'); await tick(); assert.equal(app.calls.at(-1).path, '/api/routines/routine-1'); assert.equal(app.calls.at(-1).options.method, 'DELETE');
  assert.match(app.text(), /대화 기록은 그대로/); assert.equal(app.changes.at(-1).action, 'delete'); app.ui.destroy();
});
