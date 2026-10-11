import test from 'node:test';
import assert from 'node:assert/strict';
import {mergePendingMessages, failedOutcome} from '../public/conversation-ui.mjs';

const human = (id = 'turn') => ({id, kind: 'human', text: '요청'});
const reply = text => ({id: 'reply', kind: 'bot', text});

test('optimistic messages remain until exact server message or own nonce reconciliation', () => {
  const pending = {id: 'pending:nonce', kind: 'human', text: '같은 문장', clientNonceHash: 'a'.repeat(64)};
  const sameText = [{id: 'other-user-message', kind: 'human', text: '같은 문장'}];
  assert.deepEqual(mergePendingMessages(sameText, pending), [...sameText, pending]);
  assert.equal(sameText.length, 1);
  const accepted = [{id: 'server-id', clientNonceHash: pending.clientNonceHash}];
  assert.equal(mergePendingMessages(accepted, pending), accepted);
  assert.equal(mergePendingMessages(accepted, {...pending, id: 'server-id', clientNonceHash: undefined}), accepted);
  assert.equal(mergePendingMessages(sameText, null), sameText);
  assert.equal(mergePendingMessages([{}], {text: 'unsaved'}).length, 2);
});

test('failed outcomes recognize actual refusal and server errors, including empty model output', () => {
  for (const text of [
    '현재 네이버 메일에 접근할 권한이 없습니다. 다시 연결해 주세요.',
    '죄송합니다. 이 환경에서는 파일을 읽을 수 없습니다.',
    '요청하신 작업은 완료하지 못했습니다.',
    '이 기능은 지원하지 않습니다.',
    'I cannot access your mailbox.',
    "I'm sorry. I am unable to execute this request.",
  ]) assert.equal(failedOutcome([human(), reply(text)]).failed, true, text);
  for (const text of ['봇이 답변을 완료하지 못했습니다. 모델 연결이나 사용량 제한을 확인해 주세요.', '모델이 답변을 반환하지 않았습니다. 다시 시도하거나 다른 모델을 선택해 주세요.']) {
    assert.equal(failedOutcome([human(), {id: 'system-error', kind: 'system', text}]).failed, true, text);
  }
});

test('quoted errors, explanations, successful fixes, and previous turns do not count as failures', () => {
  for (const text of [
    '“접근할 권한이 없습니다” 오류를 해결했습니다.',
    '> 현재 접근할 수 없습니다.\n위 오류는 예시입니다.',
    '```\n할 수 없습니다\n```',
    '현재 접근할 수 없을 때 발생하는 오류를 설명할게요.',
    '로그인을 해제하면 메일에 접근할 수 없습니다.',
    '접근할 수 없습니다라는 오류는 해결했습니다.',
    '로그인 문제를 수정했습니다. 이제 메일을 읽을 수 있습니다.',
    "I'm sorry for the delay. The task is complete.",
    '죄송합니다. 작업은 완료했습니다.',
  ]) assert.equal(failedOutcome([human(), reply(text)]).failed, false, text);
  const result = failedOutcome([human('old'), reply('할 수 없습니다.'), human('new')]);
  assert.deepEqual(result, {humanId: 'new', failed: false, messageId: null});
});


test('unavailable OCR capability is a persistent failed outcome without classifying quoted or resolved notices', () => {
  const refusal = '죄송하지만, 현재 이 방에서는 사진의 OCR을 읽는 기능이 제공되지 않습니다.';
  assert.deepEqual(failedOutcome([human(), reply(refusal)]), {humanId: 'turn', failed: true, messageId: 'reply'});
  for (const text of [
    '현재 OCR 기능이 제공되어 있지 않습니다.',
    '이 환경에서는 OCR 기능이 지원되지 않아요.',
  ]) assert.equal(failedOutcome([human(), reply(text)]).failed, true, text);
  for (const text of [
    '“OCR 기능이 제공되지 않습니다” 안내는 해결했습니다.',
    '현재 표시되는 \"OCR 기능이 제공되지 않습니다\" 문구의 의미를 설명할게요.',
    'OCR 설정을 해제하면 기능이 제공되지 않습니다.',
    'OCR 기능이 제공되지 않습니다라는 오류는 수정했습니다.',
    'OCR 설정을 복구했습니다. 기능이 정상 제공됩니다.',
  ]) assert.equal(failedOutcome([human(), reply(text)]).failed, false, text);
  assert.deepEqual(failedOutcome([human('prior'), reply(refusal), human('next')]), {humanId: 'next', failed: false, messageId: null});
});
