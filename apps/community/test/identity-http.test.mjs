import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';
import {serviceIdentity} from '../identity.mjs';

async function fixture(t, backend = 'api') {
  const dir = await mkdtemp(join(tmpdir(), 'community-identity-')), requests = [];
  const privateContext = join(dir, 'operator.md');
  const oldNotes = '# 과거 기록\n서비스: OpenClawBot\n성격: 친근하고 간결하게 답합니다.';
  await writeFile(privateContext, oldNotes, {mode: 0o600});
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    if (body) requests.push({path: req.url, body});
    const prompt = (body?.messages || body?.input || []).find(item => item.role === 'system')?.content || '';
    const responseText = prompt.includes('첫 메시지를 요약해') ? '테스트 제목' : prompt.includes('대화 기록을 압축합니다') ? '현재 결정만 간결하게 요약' : prompt.includes('이미지 판독기입니다') ? '이미지 판독 완료' : '현재 이름으로 답변했습니다.';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/models' ? {data: [{id: 'gemini-3.8-flash'}]} : req.url === '/v1/responses' ? {output_text: responseText} : {choices: [{message: {role: 'assistant', content: responseText}}]}));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const env = {COMMUNITY_BOOTSTRAP_TOKEN: 'bootstrap', COMMUNITY_AGENT_CONTEXT_FILE: privateContext,
    ...(backend === 'api' ? {COMMUNITY_LLM_BASE_URL: baseUrl + '/v1', COMMUNITY_LLM_API_KEY: 'fixture-key', COMMUNITY_LLM_MODEL: 'gemini-3.8-flash'} : {COMMUNITY_OPENCLAW_BASE_URL: baseUrl, COMMUNITY_OPENCLAW_TOKEN: 'gateway-fixture-token'})};
  const app = await startCommunity({dataDir: join(dir, 'state'), port: 0, env, integrations: {list: async () => []}});
  t.after(async () => {await app.close(); await new Promise(resolve => upstream.close(resolve)); await rm(dir, {recursive: true, force: true});});
  let cookie = '', csrf = '';
  async function call(path, body) {
    const response = await fetch(app.url + path, {method: body === undefined ? 'GET' : 'POST', headers: {'content-type': 'application/json', cookie, 'x-csrf-token': csrf}, body: body === undefined ? undefined : JSON.stringify(body)});
    const data = await response.json();
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    if (data.csrfToken) csrf = data.csrfToken;
    return {status: response.status, data};
  }
  assert.equal((await call('/api/register', {username: 'brand_owner', displayName: 'Owner', password: 'brand-test-passphrase', inviteToken: 'bootstrap'})).status, 201);
  const setName = async displayName => assert.equal((await call('/api/admin/setup', {displayName})).status, 200);
  const send = async (roomId, text, extra = {}) => {
    const result = await call(`/api/rooms/${roomId}/messages`, {text, botIds: ['bot-analyst'], clientNonce: randomUUID(), ...extra});
    assert.equal(result.status, 202);
    const progress = await fetch(`${app.url}/api/rooms/${roomId}/progress`, {headers: {cookie}, signal: AbortSignal.timeout(5000)});
    assert.match(await progress.text(), /event: done/);
    return result.data;
  };
  async function image(roomId) {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=', 'base64');
    const form = new FormData(); form.append('file', new Blob([png], {type: 'image/png'}), 'sample.png');
    const response = await fetch(`${app.url}/api/rooms/${roomId}/attachments`, {method: 'POST', headers: {cookie, 'x-csrf-token': csrf}, body: form});
    assert.equal(response.status, 201); return (await response.json()).attachment.id;
  }
  return {app, call, setName, send, image, requests, oldNotes};
}

test('actual API requests use the live configured identity despite old transcript, summary, and operator notes', async t => {
  const f = await fixture(t), name = '나만의 구름 비서';
  await f.setName(name);
  const personal = (await f.call('/api/rooms')).data.rooms.find(room => room.personal);
  const old = await f.send(personal.id, '예전 서비스 이름은 OpenClawBot이었다.', {botIds: []});
  const through = f.app.db.prepare('SELECT rowid FROM messages WHERE id=?').get(old.messageId).rowid;
  f.app.db.prepare('INSERT INTO settings VALUES(?,?)').run('context:' + personal.id, JSON.stringify({summary: '이전 자기소개: OpenClawBot', through}));
  await f.send(personal.id, '지금 네 이름은 뭐야?');
  const chat = f.requests.at(-1).body.messages;
  const system = chat.find(item => item.role === 'system').content;
  assert.ok(system.startsWith(serviceIdentity(name)));
  assert.ok(system.includes(f.oldNotes), 'operator personality and historical notes are preserved');
  assert.match(system, /현재 서비스 이름은 바뀌지 않습니다/);
  assert.match(chat.find(item => item.role === 'user').content, /이전 자기소개: OpenClawBot/);
  assert.doesNotMatch(system, /당신은 OpenClawBot의/);
  await f.setName('바뀐 구름 비서');
  await f.send(personal.id, '이름을 다시 알려줘.');
  assert.ok(f.requests.at(-1).body.messages[0].content.startsWith(serviceIdentity('바뀐 구름 비서')));
  assert.ok((await f.call(`/api/rooms/${personal.id}`)).data.messages.some(message => message.id === old.messageId && message.text.includes('OpenClawBot')), 'history is not rewritten');
});

test('title, compact, image reading, and private-service prompts share the configured identity', async t => {
  const f = await fixture(t), name = 'My Cloud Assistant'; await f.setName(name);
  const room = (await f.call('/api/rooms', {})).data.room.id;
  await f.send(room, '금요일에 배포할 계획과 유지할 결정 사항을 설명합니다. '.repeat(40));
  assert.equal((await f.call(`/api/rooms/${room}/compact`, {})).status, 200);
  const attachmentId = await f.image(room);
  await f.send(room, '첨부 사진을 읽어주세요.', {attachmentIds: [attachmentId]});
  assert.equal((await f.call('/api/admin/integrations/ask', {prompt: '연결된 서비스를 알려주세요.'})).status, 200);
  const systems = f.requests.map(item => item.body.messages?.find(message => message.role === 'system')?.content).filter(Boolean);
  for (const marker of ['첫 메시지를 요약해', '대화 기록을 압축합니다', '이미지 판독기입니다', '관리자 개인 비서입니다']) {
    const prompt = systems.find(system => system.includes(marker)); assert.ok(prompt, marker); assert.ok(prompt.startsWith(serviceIdentity(name)), marker);
  }
});

test('the OpenClaw transport preserves configured product identity and keeps its protocol identity separate', async t => {
  const f = await fixture(t, 'gateway'); await f.setName('Gateway 사용자 비서');
  const room = (await f.call('/api/rooms', {name: 'identity gateway'})).data.room.id;
  await f.send(room, '자기소개를 해줘.');
  const request = f.requests.find(item => item.path === '/v1/responses');
  assert.ok(request);
  assert.ok(request.body.input.find(item => item.role === 'system').content.startsWith(serviceIdentity('Gateway 사용자 비서')));
  assert.equal(request.body.model, 'openclaw/default', 'underlying engine protocol remains compatible');
});
