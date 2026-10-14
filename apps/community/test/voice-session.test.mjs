import test from 'node:test';
import assert from 'node:assert/strict';
import {callReply, speechText, callLink, createSpeechGate} from '../public/voice-session.mjs';

const human = id => ({id, kind: 'human', text: '질문'});
const bot = (id, text) => ({id, kind: 'bot', text});

test('call replies are anchored to the accepted human message, not earlier or another participant turns', () => {
  assert.deepEqual(callReply({messages: [human('old'), bot('old-answer', '예전 답변')], busy: false}, 'accepted'), {state: 'waiting'});
  assert.deepEqual(callReply({messages: [bot('accepted', 'ID만 같은 봇 답변')], busy: false}, 'accepted'), {state: 'waiting'});
  assert.deepEqual(callReply({messages: [human('old'), bot('prior', '예전 답변'), human('accepted')], busy: true}, 'accepted'), {state: 'waiting'});
  assert.deepEqual(callReply({messages: [human('accepted'), human('another-user'), bot('other', '다른 사람의 답변')]}, 'accepted'), {state: 'interrupted'});
  assert.deepEqual(callReply({messages: [human('accepted'), bot('own', '이 통화의 답변'), human('another-user')]}, 'accepted'), {state: 'reply', text: '이 통화의 답변'});
  assert.deepEqual(callReply({messages: [human('accepted'), {kind: 'system', text: '모델 연결 실패'}]}, 'accepted'), {state: 'error', text: '모델 연결 실패'});
  assert.deepEqual(callReply({messages: [human('accepted'), bot('empty', '  ')], busy: false}, 'accepted'), {state: 'empty'});
});

test('speech keeps readable content, omits code/URLs and bounds long answers', () => {
  const text = speechText('# 답변\n[문서](https://example.org) ![사진](https://example.org/image.png)\n```sh\nsecret-command\n```\nhttps://example.org/private');
  assert.match(text, /답변 문서/);
  assert.match(text, /코드 내용은 대화에 남겨두었어요/);
  assert.doesNotMatch(text, /secret-command|https|사진/);
  assert.ok(speechText('가'.repeat(9000)).length < 1300);
});

test('call link identifies an exact conversation without inheriting current query/fragment', () => {
  const url = new URL(callLink('https://bots.example.org/?token=private#old', 'room/a?x=1'));
  assert.equal(url.origin, 'https://bots.example.org');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('room'), 'room/a?x=1');
  assert.equal(url.searchParams.get('call'), '1');
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(url.hash, '');
});

test('VAD ignores isolated noise and silence but sends a real phrase once the pause is long enough', () => {
  const gate = createSpeechGate();
  assert.equal(gate.sample(0, 0), 'listen');
  assert.equal(gate.sample(0.1, 60), 'listen');
  assert.equal(gate.sample(0.1, 120), 'listen');
  assert.equal(gate.sample(0, 180), 'listen');
  assert.equal(gate.voiced, false);
  for (const now of [240, 300, 360]) assert.equal(gate.sample(0.1, now), 'listen');
  assert.equal(gate.voiced, true);
  assert.equal(gate.sample(0, 1459), 'listen');
  assert.equal(gate.sample(0, 1460), 'send');
});

test('VAD bounds both silent capture and uninterrupted speech', () => {
  const quiet = createSpeechGate({maxMs: 30000});
  quiet.sample(0, 100);
  assert.equal(quiet.sample(0, 30099), 'listen');
  assert.equal(quiet.sample(0, 30100), 'discard');
  assert.equal(quiet.voiced, false);
  const long = createSpeechGate({maxMs: 30000});
  for (const now of [0, 60, 120, 29999]) assert.equal(long.sample(0.1, now), 'listen');
  assert.equal(long.sample(0.1, 30000), 'send');
});
