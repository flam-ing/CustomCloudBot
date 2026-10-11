// Local outbox entries remain visible until their exact server nonce is observed.
export function mergePendingMessages(messages, pending) {
  if (!pending) return messages;
  if (messages.some(message => (pending.id && message.id === pending.id) || (pending.clientNonceHash && message.clientNonceHash === pending.clientNonceHash))) return messages;
  return [...messages, pending];
}
function openingReply(value) {
  const text = String(value || '').trim().replace(/\*\*/g, '');
  // Quoted errors, logs, and example code describe data rather than an outcome.
  if (/^(?:>|```|~~~|["'“‘「])/.test(text)) return '';
  const lines = text.split(/[\n.!?。]+/).map(line => line.trim()).filter(Boolean);
  let opening = lines[0] || '';
  if (/^(?:죄송합니다|죄송해요|미안합니다|미안해요|아쉽지만|I(?:'m| am) sorry|Sorry)$/i.test(opening)) opening = lines[1] || '';
  return opening.slice(0, 240).replace(/(["'“‘「])[^"'”’」]*["'”’」]/g, '');
}
function isFailedReply(message) {
  const text = String(message.text || '').trim();
  if (message.kind === 'system') return /답변.*(?:못했|실패|완료하지 못|반환하지 않)|모델.*(?:없습니다|제한)|요청.*완료하지 못/.test(text);
  const opening = openingReply(text);
  // A repaired error or a conditional example must not leave the agent red.
  if (/(?:해결|복구|수정|완료|성공)(?:했|됐|되었|하였습니다|했습니다)|(?:문구|오류 메시지).*(?:의미|뜻)|(?:경우|때에는|때는|다면|하면)/.test(opening)) return false;
  return /(?:접근할 권한이|접근할 수|실행할 수|처리할 수|확인할 수|조회할 수|읽을 수|보낼 수|사용할 수|할 수)\s*(?:없습니다|없어요|없다)|(?:제공|지원)(?:하지|되지|되어 있지)\s*(?:않습니다|않아요)|완료하지 (?:못했습니다|못했어요)|불가능(?:합니다|해요)/.test(opening) ||
    /^(?:I (?:cannot|can't|am unable to)|I(?:'m| am) unable to|Unfortunately,? I (?:cannot|can't))/i.test(opening);
}
export function failedOutcome(messages = []) {
  let human = null, replies = [];
  for (const message of messages) {
    if (message.kind === 'human') { human = message.id; replies = []; }
    else if (message.kind === 'bot' || message.kind === 'system') replies.push(message);
  }
  const failure = replies.find(isFailedReply);
  return {humanId:human, failed:Boolean(failure), messageId:failure?.id || null};
}
