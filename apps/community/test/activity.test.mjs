import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

const answer = content => 'SendMessage: ' + JSON.stringify({type: 'text', content});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'community-room-activity-'));
  const started = Promise.withResolvers(), completion = Promise.withResolvers();
  const app = await startCommunity({dataDir: dir, port: 0, env: {COMMUNITY_BOOTSTRAP_TOKEN: 'activity-bootstrap'}, llm: {
    name: 'held-activity-test',
    async complete(request, signal) {
      if (request.isolation?.botId === 'title') return answer('활동 테스트');
      started.resolve(request);
      const abort = () => completion.reject(signal.reason ?? new Error('aborted'));
      signal?.addEventListener('abort', abort, {once: true});
      try { return await completion.promise; }
      finally { signal?.removeEventListener('abort', abort); }
    },
  }});
  t.after(async () => {
    completion.resolve(answer('테스트 종료'));
    await app.close();
    await rm(dir, {recursive: true, force: true});
  });
  async function call(path, auth, body) {
    const response = await fetch(app.url + path, {method: body === undefined ? 'GET' : 'POST',
      headers: {'content-type': 'application/json', ...(auth ? {cookie: auth.cookie, 'x-csrf-token': auth.csrf} : {})},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000)});
    return {status: response.status, data: await response.json(), response};
  }
  async function register(username, admin) {
    const inviteToken = admin ? (await call('/api/admin/invites', admin, {})).data.token : 'activity-bootstrap';
    const result = await call('/api/register', null, {username, displayName: username, password: 'activity-test-password', inviteToken});
    assert.equal(result.status, 201);
    return {id: result.data.user.id, csrf: result.data.csrfToken, cookie: result.response.headers.get('set-cookie').split(';')[0]};
  }
  async function room(auth, name = '활동 테스트') {
    const result = await call('/api/rooms', auth, {name});
    assert.equal(result.status, 201);
    return result.data.room.id;
  }
  async function joinRoom(owner, member, id) {
    const invite = await call(`/api/rooms/${id}/invites`, owner, {});
    assert.equal(invite.status, 201);
    assert.equal((await call('/api/rooms/join', member, {token: invite.data.token})).status, 200);
  }
  async function send(auth, id) {
    const result = await call(`/api/rooms/${id}/messages`, auth, {text: 'PRIVATE_ACTIVITY_CONTENT', botIds: ['bot-analyst'], clientNonce: randomUUID()});
    assert.equal(result.status, 202);
    const request = await Promise.race([started.promise, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Model did not start')), 5000); timer.unref();
    })]);
    assert.equal(request.isolation.roomId, id);
  }
  async function finish(auth, id) {
    completion.resolve(answer('ACTIVITY_FINISHED'));
    const response = await fetch(`${app.url}/api/rooms/${id}/progress`, {headers: {cookie: auth.cookie}, signal: AbortSignal.timeout(5000)});
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: done/);
  }
  return {app, call, register, room, joinRoom, send, finish};
}

test('activity requires authentication and reveals only accessible membership IDs and booleans', async t => {
  const f = await fixture(t), owner = await f.register('activity_owner'), member = await f.register('activity_member', owner);
  const shared = await f.room(owner), hidden = await f.room(owner), memberOnly = await f.room(member);
  await f.joinRoom(owner, member, shared);
  assert.equal((await f.call('/api/rooms/activity')).status, 401);

  for (const [auth, present, absent] of [[owner, [shared, hidden], [memberOnly]], [member, [shared, memberOnly], [hidden]]]) {
    const listed = await f.call('/api/rooms', auth);
    const activity = await f.call('/api/rooms/activity', auth);
    assert.equal(activity.status, 200);
    const ids = activity.data.rooms.map(room => room.id);
    for (const id of present) assert.ok(ids.includes(id));
    for (const id of absent) assert.ok(!ids.includes(id), 'admin role alone must not expose another member’s room');
    assert.deepEqual(ids.toSorted(), listed.data.rooms.map(room => room.id).toSorted());
    for (const value of activity.data.rooms) {
      assert.deepEqual(Object.keys(value).sort(), ['busy', 'id']);
      assert.equal(value.busy, false);
    }
    for (const room of listed.data.rooms) assert.equal(room.busy, false);
  }

  // Stale memberships must not bypass the same private-room checks as room GET.
  const mail = await f.room(owner), personal = await f.room(owner);
  f.app.db.prepare('INSERT INTO settings VALUES(?,?)').run('mail-room:' + mail, '1');
  f.app.db.prepare('INSERT INTO settings VALUES(?,?)').run('private-fork:' + personal, '1');
  for (const id of [mail, personal]) f.app.db.prepare('INSERT INTO room_members VALUES(?,?,?)').run(id, member.id, 'member');
  const activity = (await f.call('/api/rooms/activity', member)).data.rooms;
  for (const id of [mail, personal]) {
    assert.equal((await f.call(`/api/rooms/${id}`, member)).status, 404);
    assert.ok(!activity.some(room => room.id === id));
  }
});

test('activity and room listings show a held model run as busy, then clear it after completion', async t => {
  const f = await fixture(t), owner = await f.register('running_owner'), member = await f.register('running_member', owner);
  const running = await f.room(owner), idle = await f.room(owner);
  await f.joinRoom(owner, member, running);
  await f.send(owner, running);
  for (const auth of [owner, member]) {
    const activity = await f.call('/api/rooms/activity', auth);
    assert.equal(activity.data.rooms.find(room => room.id === running)?.busy, true);
    assert.doesNotMatch(JSON.stringify(activity.data), /PRIVATE_ACTIVITY_CONTENT|ACTIVITY_FINISHED/);
    const listed = await f.call('/api/rooms', auth);
    assert.equal(listed.data.rooms.find(room => room.id === running)?.busy, true);
  }
  assert.equal((await f.call('/api/rooms/activity', owner)).data.rooms.find(room => room.id === idle)?.busy, false);
  await f.finish(owner, running);
  for (const auth of [owner, member]) {
    for (const path of ['/api/rooms/activity', '/api/rooms']) {
      assert.equal((await f.call(path, auth)).data.rooms.find(room => room.id === running)?.busy, false);
    }
  }
});

test('revoking membership hides an active room immediately without stopping its owner’s run', async t => {
  const f = await fixture(t), owner = await f.register('revoked_owner'), member = await f.register('revoked_member', owner);
  const running = await f.room(owner);
  await f.joinRoom(owner, member, running);
  await f.send(owner, running);
  assert.equal((await f.call('/api/rooms/activity', member)).data.rooms.find(room => room.id === running)?.busy, true);
  f.app.db.prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').run(running, member.id);
  for (const path of ['/api/rooms/activity', '/api/rooms']) {
    assert.ok(!(await f.call(path, member)).data.rooms.some(room => room.id === running));
  }
  assert.equal((await f.call('/api/rooms/activity', owner)).data.rooms.find(room => room.id === running)?.busy, true);
  await f.finish(owner, running);
});
