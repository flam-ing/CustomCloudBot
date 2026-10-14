// Queued requests belong to the server. They are not part of the conversation until dispatched.
export function createMessageQueue({api, getSession, onRefresh, toast}) {
  const operations = new Map();
  let generation = 0;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function render(form, roomId, queue = []) {
    if (!form) return;
    form.dataset.queueRoomId = roomId || '';
    form.querySelector('.message-queue')?.remove();
    const items = queue.filter(item => item.roomId === roomId && item.state === 'queued');
    if (!items.length) return;
    const userId = getSession()?.user?.id, version = generation;
    const panel = element('section', undefined, 'message-queue');
    panel.setAttribute('aria-label', '보내기 대기 중인 메시지');
    const count = element('div', `대기 중 · ${items.length}`, 'message-queue-count');
    count.setAttribute('role', 'status');
    const list = element('div', undefined, 'message-queue-list');
    panel.append(count, list);
    for (const item of items) {
      const row = element('div', undefined, 'message-queue-item');
      row.dataset.queueId = item.id;
      const content = element('div', undefined, 'message-queue-copy');
      const preview = element('p', item.text || '첨부 파일', 'message-queue-preview');
      preview.title = item.text || '첨부 파일';
      content.append(preview);
      const details = [item.authorId !== userId ? item.author : '', ...(item.attachmentNames || [])].filter(Boolean);
      if (details.length) content.append(element('small', details.join(' · '), 'message-queue-detail'));
      if (item.steering) {
        const status = element('small', '진행 중인 요청에 반영 중', 'message-queue-steering');
        status.setAttribute('role', 'status'); content.append(status);
      }
      row.append(content);
      const actions = element('div', undefined, 'message-queue-actions');
      const key = `${roomId}:${item.id}`;
      const current = () => version === generation && userId === getSession()?.user?.id && form.isConnected && form.dataset.queueRoomId === roomId;
      const run = async action => {
        if (!current() || operations.has(key) || (action === 'send-now' && item.steering)) return;
        const operation = Symbol(key); operations.set(key, operation);
        for (const button of actions.querySelectorAll('button')) button.disabled = true;
        try {
          await api(`/api/rooms/${encodeURIComponent(roomId)}/queue/${encodeURIComponent(item.id)}${action === 'send-now' ? '/send-now' : ''}`, {
            method: action === 'send-now' ? 'POST' : 'DELETE', ...(action === 'send-now' ? {body: '{}'} : {}),
          });
          if (current()) await onRefresh(roomId);
        } catch (error) {
          if (current()) toast(error.message);
        } finally {
          if (operations.get(key) === operation) operations.delete(key);
          if (current()) for (const currentRow of form.querySelectorAll('.message-queue-item')) {
            if (currentRow.dataset.queueId === item.id) for (const button of currentRow.querySelectorAll('button')) button.disabled = button.dataset.steering === 'true';
          }
        }
      };
      if (item.canSendNow) {
        const send = element('button', '지금 보내기', 'message-queue-send');
        send.type = 'button'; send.title = '진행 중인 요청에 이 내용을 추가해 바로 반영합니다';
        send.dataset.steering = String(!!item.steering);
        send.disabled = operations.has(key) || !!item.steering; send.onclick = () => run('send-now'); actions.append(send);
      }
      if (item.canCancel) {
        const cancel = element('button', '×', 'message-queue-cancel');
        cancel.type = 'button'; cancel.title = '대기 취소'; cancel.setAttribute('aria-label', '대기 메시지 취소');
        cancel.disabled = operations.has(key); cancel.onclick = () => run('cancel'); actions.append(cancel);
      }
      row.append(actions); list.append(row);
    }
    form.prepend(panel);
  }
  return {render, reset() { generation++; operations.clear(); }};
}
