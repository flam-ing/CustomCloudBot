import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoiceTranscriber, VOICE_MAX_BYTES } from '../voice.mjs';
import { createSetupVault } from '../setup-vault.mjs';
import { startCommunity } from '../server.mjs';

function wav() {
  const bytes = Buffer.alloc(44 + 3200);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(3200, 40);
  return bytes;
}
const input = () => ({ bytes: wav(), mime: 'audio/wav' });
const answer = text => Response.json({ text, duration: 0.1 });

test('voice discovers added Vault keys dynamically and only uses the fixed Groq transcription endpoint', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-vault-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = createSetupVault(dir, { OPENAI_API_KEY: 'unrelated-paid-key' });
  const calls = [];
  const voice = createVoiceTranscriber({ getEnv: () => vault.runtimeEnv(), fetchImpl: async (url, request) => {
    calls.push({ url, request });
    assert.deepEqual(Buffer.from(await request.body.get('file').arrayBuffer()), wav());
    assert.equal(request.body.get('model'), 'whisper-large-v3-turbo');
    assert.equal(request.body.get('response_format'), 'verbose_json');
    assert.equal(request.redirect, 'error');
    return answer(' 현재 대화 내용을 이어서 알려 줘. ');
  }});
  assert.equal(voice.status().configured, false);
  vault.importResources({ source: 'voice-fixture', values: { GROQ_API_KEY: 'private-groq-fixture' } });
  assert.deepEqual(voice.status(), { configured: true, provider: 'groq', maxSeconds: 30, maxBytes: VOICE_MAX_BYTES });
  assert.deepEqual(await voice.transcribe(input()), { text: '현재 대화 내용을 이어서 알려 줘.' });
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(calls[0].request.headers.authorization, 'Bearer private-groq-fixture');
  assert.ok(!JSON.stringify(voice.status()).includes('private-groq-fixture'));
  const custom = createVoiceTranscriber({ getEnv: () => ({ GROQ_API_KEY: 'custom-secret', GROQ_BASE_URL: 'https://unrelated.example/v1' }) });
  assert.equal(custom.status().configured, false);
});

test('transcription rotates distinct Groq keys on authentication, rate and upstream errors, never another provider', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const seen = [];
    const voice = createVoiceTranscriber({ getEnv: () => ({ GROQ_API_KEY: 'first', GROQ_API_KEY_2: 'second', OPENAI_API_KEY: 'never-use' }), fetchImpl: async (_, request) => {
      seen.push(request.headers.authorization);
      return seen.length === 1 ? new Response('private upstream details', { status }) : answer('완료');
    }});
    assert.deepEqual(await voice.transcribe(input()), { text: '완료' });
    assert.deepEqual(seen, ['Bearer first', 'Bearer second']);
  }
  let attempts = 0;
  const limited = createVoiceTranscriber({ getEnv: () => Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['GROQ_API_KEY_' + i, 'fixture-' + i])), fetchImpl: async () => {
    attempts++; return new Response('private error', { status: 429 });
  }});
  await assert.rejects(limited.transcribe(input()), { status: 429 });
  assert.equal(attempts, 3);
});

test('voice bounds audio and upstream results and does not leak provider errors', async () => {
  let calls = 0, response = answer('');
  const voice = createVoiceTranscriber({ getEnv: () => ({ GROQ_API_KEY: 'fixture-key' }), fetchImpl: async () => { calls++; return response; } });
  await assert.rejects(voice.transcribe({ bytes: Buffer.alloc(VOICE_MAX_BYTES + 1), mime: 'audio/wav' }), { status: 413 });
  await assert.rejects(voice.transcribe({ bytes: wav(), mime: 'image/png' }), { status: 415 });
  assert.equal(calls, 0);
  assert.deepEqual(await voice.transcribe(input()), { text: '' });
  response = new Response('private provider error', { status: 400 });
  await assert.rejects(voice.transcribe(input()), error => error.status === 502 && !error.message.includes('private provider'));
  for (const bad of [Response.json({ text: 'x'.repeat(4001) }), new Response('{broken'), new Response('x'.repeat(65537))]) {
    response = bad;
    await assert.rejects(voice.transcribe(input()), { status: 502 });
  }
  response = Response.json({ text: 'long audio', duration: 32 });
  await assert.rejects(voice.transcribe(input()), { status: 413 });
});

test('ending a call cancels transcription without trying another key', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const voice = createVoiceTranscriber({ getEnv: () => ({ GROQ_API_KEY: 'first', GROQ_API_KEY_2: 'second' }), fetchImpl: async (_, request) => {
    attempts++;
    return new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      controller.abort();
    });
  }});
  await assert.rejects(voice.transcribe({ ...input(), signal: controller.signal }), { status: 408 });
  assert.equal(attempts, 1);
  await assert.rejects(voice.transcribe({ ...input(), signal: controller.signal }), { status: 408 });
  assert.equal(attempts, 1);
});

async function fixture(t, { configured = true, upstream } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'voice-http-'));
  const calls = [];
  const llm = { name: 'voice-test', complete: async request => {
    calls.push(request);
    return 'SendMessage: ' + JSON.stringify({ type: 'text', content: '앞선 대화를 이어서 답합니다.' });
  }};
  const app = await startCommunity({ dataDir, port: 0,
    env: { COMMUNITY_BOOTSTRAP_TOKEN: 'bootstrap', ...(configured ? { GROQ_API_KEY: 'fixture-key' } : {}) }, llm,
    voiceFetchImpl: upstream || (async () => answer('서버 권한을 확인해 줘')),
    providerPool: { configured: false, providers: [], ensureModels: async () => {}, choose: () => null },
  });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  function client() {
    let cookie = '', csrf = '';
    return {
      headers: () => ({ cookie, 'x-csrf-token': csrf }),
      async json(path, body, method = body === undefined ? 'GET' : 'POST') {
        const response = await fetch(app.url + path, { method, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const value = await response.json();
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        if (value.csrfToken) csrf = value.csrfToken;
        return { status: response.status, ...value };
      },
    };
  }
  const owner = client(), member = client();
  const registered = await owner.json('/api/register', { username: 'voice_owner', displayName: 'Owner', password: 'voice fixture password', inviteToken: 'bootstrap' });
  assert.equal(registered.status, 201);
  const invitation = await owner.json('/api/admin/invites', {});
  assert.equal((await member.json('/api/register', { username: 'voice_member', displayName: 'Member', password: 'voice fixture password', inviteToken: invitation.token })).status, 201);
  const room = (await owner.json('/api/rooms', { name: '내 서버 점검 대화' })).room;
  async function transcribe(actor = owner, bytes = wav(), mime = 'audio/wav', extraHeaders = {}) {
    const body = new FormData(); body.append('file', new Blob([bytes], { type: mime }), 'speech.wav');
    const response = await fetch(app.url + `/api/rooms/${room.id}/voice/transcribe`, { method: 'POST', headers: { ...actor.headers(), ...extraHeaders }, body });
    return { status: response.status, ...(await response.json()) };
  }
  return { app, dataDir, owner, member, ownerId: registered.user.id, room, calls, transcribe };
}

test('voice API requires session, CSRF and room membership; transcript does not execute or persist audio', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.app.url + '/api/voice')).status, 401);
  assert.equal((await f.owner.json('/api/voice')).configured, true);
  assert.equal((await f.transcribe(f.owner, wav(), 'audio/wav', { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await f.transcribe(f.member)).status, 404);
  assert.equal((await f.transcribe(f.owner, Buffer.from('invalid'), 'audio/wav')).status, 415);
  const before = f.app.db.prepare('SELECT count(*) n FROM messages').get().n;
  assert.deepEqual(await f.transcribe(), { status: 200, text: '서버 권한을 확인해 줘' });
  assert.equal(f.calls.length, 0, 'transcription must not invoke any LLM or tools');
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM messages').get().n, before);
  assert.deepEqual(await readdir(join(f.dataDir, 'media')), []);
});

test('accepted transcript uses the ordinary context and idempotent message path', async t => {
  const f = await fixture(t);
  const base = `/api/rooms/${f.room.id}`;
  assert.equal((await f.owner.json(base + '/messages', { text: '기억할 숫자는 42야.', clientNonce: 'prior-context', botIds: [] })).status, 202);
  const { text } = await f.transcribe();
  const body = { text, clientNonce: 'call:fixture:turn-1', botIds: ['bot-analyst'] };
  const first = await f.owner.json(base + '/messages', body);
  const duplicate = await f.owner.json(base + '/messages', body);
  assert.equal(first.status, 202); assert.equal(duplicate.status, 202);
  assert.equal(first.messageId, duplicate.messageId);
  const deadline = Date.now() + 5000;
  while ((await f.owner.json(base)).busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].user, /기억할 숫자는 42야/);
  assert.match(f.calls[0].user, /서버 권한을 확인해 줘/);
  assert.equal(f.calls[0].isolation.roomId, f.room.id);
  assert.equal(f.app.db.prepare("SELECT count(*) n FROM messages WHERE room_id=? AND kind='human'").get(f.room.id).n, 2);
});

test('voice API rechecks membership after upstream work and cleans failed recordings', async t => {
  let f;
  f = await fixture(t, { upstream: async () => {
    f.app.db.prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').run(f.room.id, f.ownerId);
    return answer('cannot publish this revoked transcript');
  }});
  assert.equal((await f.transcribe()).status, 404);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(join(f.dataDir, 'media')), []);
});

test('voice API sees newly saved API connections without restart', async t => {
  const f = await fixture(t, { configured: false });
  assert.equal((await f.owner.json('/api/voice')).configured, false);
  assert.equal((await f.transcribe()).status, 503);
  assert.equal((await f.owner.json('/api/admin/setup/providers', { provider: 'groq', apiKey: 'new-fixture-key' })).status, 200);
  assert.equal((await f.owner.json('/api/voice')).configured, true);
  assert.equal((await f.transcribe()).status, 200);
});

test('only one recording per account can be transcribed at a time', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { upstream: async () => { entered(); await finish; return answer('완료'); } });
  const first = f.transcribe();
  await started;
  try { assert.equal((await f.transcribe()).status, 429); }
  finally { release(); }
  assert.equal((await first).status, 200);
  assert.deepEqual(await readdir(join(f.dataDir, 'media')), []);
});
