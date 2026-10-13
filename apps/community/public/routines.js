const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
const REASONS = {room_busy: '현재 작업이 끝나기를 기다립니다', busy_expired: '대화가 사용 중이어서 건너뛰었습니다', access_revoked: '대화 접근 권한이 없습니다', missed_schedule: '지난 예약은 건너뛰었습니다', previous_run_pending: '이전 실행이 대기 중입니다', routine_paused: '예약이 일시정지되었습니다', routine_changed: '예약이 변경되었습니다', routine_deleted: '루틴이 삭제되었습니다', server_restarted: '서버가 재시작되었습니다', execution_stopped: '실행이 중단되었습니다', dispatch_failed: '메시지를 보내지 못했습니다'};
const STATUSES = {queued: '실행 대기', running: '보내는 중', submitted: '대화에 보냄', failed: '실행 실패', interrupted: '중단됨', skipped: '이번 실행 건너뜀'};
function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function button(text, action, className = 'routine-button') {
  const item = node('button', className, text); item.type = 'button';
  item.addEventListener('click', action); return item;
}
export function routineStatusLabel(status) { return STATUSES[status] || '아직 실행하지 않음'; }
export function routineReasonLabel(reason) { return REASONS[reason] || ''; }
export function routineScheduleLabel(schedule = {}) {
  if (schedule.type === 'interval') return `${schedule.everyMinutes}분마다`;
  const days = schedule.type === 'weekly' ? (schedule.daysOfWeek || []).map(day => DAYS[day - 1]).filter(Boolean).join('·') : '매일';
  return `${days || '요일 미선택'} ${schedule.time || ''} · ${schedule.timezone || 'Asia/Seoul'}`;
}
export function validateRoutineSchedule(schedule) {
  if (!['daily', 'weekly', 'interval'].includes(schedule.type)) throw new Error('반복 일정을 선택해 주세요.');
  if (schedule.type === 'interval') {
    if (!Number.isInteger(schedule.everyMinutes) || schedule.everyMinutes < 5 || schedule.everyMinutes > 10080) throw new Error('실행 간격은 5~10080분 사이의 정수로 입력해 주세요.');
    const timezone = schedule.timezone || 'Asia/Seoul';
    try { new Intl.DateTimeFormat('ko-KR', {timeZone: timezone}).format(); }
    catch { throw new Error('올바른 시간대를 입력해 주세요. 예: Asia/Seoul'); }
    return {type: 'interval', everyMinutes: schedule.everyMinutes, timezone};
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('실행할 시간을 입력해 주세요.');
  try { new Intl.DateTimeFormat('ko-KR', {timeZone: schedule.timezone}).format(); }
  catch { throw new Error('올바른 시간대를 입력해 주세요. 예: Asia/Seoul'); }
  if (!schedule.timezone) throw new Error('시간대를 입력해 주세요.');
  const result = {type: schedule.type, time: schedule.time, timezone: schedule.timezone};
  if (schedule.type === 'weekly') {
    const days = [...new Set(schedule.daysOfWeek || [])].filter(day => Number.isInteger(day) && day >= 1 && day <= 7).sort((a, b) => a - b);
    if (!days.length) throw new Error('반복할 요일을 하나 이상 선택해 주세요.');
    result.daysOfWeek = days;
  }
  return result;
}
function dateLabel(value, timezone = 'Asia/Seoul') {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
  try { return new Intl.DateTimeFormat('ko-KR', {timeZone: timezone, month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit'}).format(date); }
  catch { return dateLabel(value); }
}
function roomId(value) { return typeof value === 'string' ? value : value?.id || value?.room?.id; }

export function createRoutineUI({api, getSession, getRoom, onChanged, toast}) {
  let dialog, generation = 0, returnFocus, timer, view;
  function close() {
    generation += 1; clearTimeout(timer); timer = null;
    if (dialog?.open) dialog.close();
    dialog?.replaceChildren(); view = null;
    const target = returnFocus; returnFocus = null;
    if (target?.isConnected) target.focus();
  }
  function current(active) {
    if (view !== active || active.generation !== generation || !dialog?.open) return false;
    if (getSession()?.user?.id !== active.userId || (getRoom && roomId(getRoom()) !== active.room.id)) { close(); return false; }
    return true;
  }
  function notify(active, action, routine) {
    if (!current(active)) return;
    try { Promise.resolve(onChanged?.({roomId: active.room.id, action, routine})).catch(() => {}); } catch { /* The saved result does not depend on a refresh callback. */ }
  }
  function setBusy(active, busy) {
    active.busy = busy;
    for (const control of dialog.querySelectorAll('button, input, textarea, select')) {
      if (control.dataset.close !== 'true') control.disabled = busy;
    }
    if (!busy) updateScheduleFields(active);
  }
  function scheduleRefresh(active) {
    clearTimeout(timer);
    if (current(active)) timer = setTimeout(() => { if (current(active)) void load(active, false); }, 15000);
  }
  async function load(active, visible = true) {
    if (!current(active)) return;
    if (active.busy) { scheduleRefresh(active); return; }
    const sequence = ++active.sequence;
    if (visible) active.status.textContent = '루틴을 불러오는 중…';
    try {
      const result = await api(`/api/rooms/${encodeURIComponent(active.room.id)}/routines`);
      if (!current(active) || active.sequence !== sequence) return;
      active.routines = Array.isArray(result.routines) ? result.routines : [];
      active.loaded = true; active.status.textContent = ''; renderList(active);
    } catch (error) {
      if (current(active) && active.sequence === sequence && visible) active.status.textContent = error.message || '루틴을 불러오지 못했습니다.';
    } finally { if (current(active) && active.sequence === sequence) scheduleRefresh(active); }
  }
  async function mutate(active, path, options, action, routine) {
    if (!current(active) || active.busy) return;
    active.sequence += 1; clearTimeout(timer);
    const focusedAction = document.activeElement?.dataset.routineAction, focusedId = document.activeElement?.dataset.routineId;
    setBusy(active, true); active.status.textContent = '';
    try {
      const result = await api(path, options);
      if (!current(active)) return;
      if (action === 'delete') active.routines = active.routines.filter(item => item.id !== routine.id);
      else if (result.routine) {
        const index = active.routines.findIndex(item => item.id === result.routine.id);
        if (index < 0) active.routines.unshift(result.routine); else active.routines[index] = result.routine;
      }
      if (action === 'save' || (action === 'delete' && active.editing?.id === routine.id)) { active.editor.hidden = true; active.form.reset(); active.editing = null; }
      if (action === 'run') active.runIds.delete(routine.id);
      active.confirmDelete = null; renderList(active); setBusy(active, false);
      active.status.textContent = action === 'run' ? '대화에 실행을 요청했습니다.' : action === 'delete' ? '루틴을 삭제했습니다. 대화 기록은 그대로 남습니다.' : '저장했습니다.';
      notify(active, action, result.routine || routine);
      if (current(active)) {
        if (action === 'save' || action === 'delete') active.add.focus();
        else if (focusedAction) [...active.list.querySelectorAll('button')].find(item => item.dataset.routineAction === focusedAction && item.dataset.routineId === focusedId)?.focus();
      }
      return result;
    } catch (error) {
      if (current(active)) active.status.textContent = error.message || '요청을 처리하지 못했습니다. 다시 시도해 주세요.';
    } finally {
      if (current(active)) { setBusy(active, false); scheduleRefresh(active); }
    }
  }
  function renderList(active) {
    const focusedAction = document.activeElement?.dataset.routineAction, focusedId = document.activeElement?.dataset.routineId;
    active.list.replaceChildren();
    if (!active.routines.length) { active.list.append(node('p', 'routine-empty', active.loaded ? '아직 루틴이 없습니다. 반복할 메시지부터 적어 보세요.' : '')); return; }
    for (const routine of active.routines) {
      const card = node('article', 'routine-item');
      const heading = node('div', 'routine-item-heading');
      heading.append(node('h3', '', routine.title || '반복 메시지'), node('span', `routine-enabled ${routine.enabled ? 'is-enabled' : ''}`, routine.enabled ? '예약 켜짐' : '일시정지'));
      const prompt = node('p', 'routine-prompt', routine.prompt || '');
      const schedule = node('p', 'routine-meta', routineScheduleLabel(routine.schedule));
      const next = routine.enabled ? dateLabel(routine.nextRunAt, routine.schedule?.timezone) : '';
      const result = node('p', 'routine-meta', `${next ? `다음 ${next} · ` : ''}${routineStatusLabel(routine.lastStatus)}${dateLabel(routine.lastRunAt, routine.schedule?.timezone) ? ` · ${dateLabel(routine.lastRunAt, routine.schedule?.timezone)}` : ''}`);
      const reason = routineReasonLabel(routine.lastReason || routine.runs?.[0]?.reason);
      if (reason) result.textContent += ` · ${reason}`;
      const actions = node('div', 'routine-actions');
      const edit = button('수정', () => showEditor(active, routine)); edit.setAttribute('aria-label', `${routine.title || '루틴'} 수정`);
      const run = button('지금 실행', () => {
        if (!current(active) || active.busy) return;
        if (!active.runIds.has(routine.id)) active.runIds.set(routine.id, crypto.randomUUID());
        void mutate(active, `/api/routines/${encodeURIComponent(routine.id)}/run`, {method: 'POST', body: JSON.stringify({requestId: active.runIds.get(routine.id)})}, 'run', routine);
      }); run.setAttribute('aria-label', `${routine.title || '루틴'} 지금 실행`);
      const toggle = button(routine.enabled ? '일시정지' : '예약 켜기', () => void mutate(active, `/api/routines/${encodeURIComponent(routine.id)}`, {method: 'PATCH', body: JSON.stringify({enabled: !routine.enabled})}, 'toggle', routine));
      const remove = button('삭제', () => { if (!current(active) || active.busy) return; active.confirmDelete = routine.id; renderList(active); active.list.querySelector('[data-confirm-delete]')?.focus(); }, 'routine-button routine-delete');
      for (const [control, action] of [[run, 'run'], [edit, 'edit'], [toggle, 'toggle'], [remove, 'delete']]) { control.dataset.routineAction = action; control.dataset.routineId = routine.id; }
      actions.append(run, edit, toggle, remove); card.append(heading, prompt, schedule, result, actions);
      if (active.confirmDelete === routine.id) {
        const confirm = node('div', 'routine-delete-confirm'); confirm.append(node('span', '', '이 루틴을 삭제할까요? 대화는 유지됩니다.'));
        const yes = button('루틴 삭제', () => void mutate(active, `/api/routines/${encodeURIComponent(routine.id)}`, {method: 'DELETE'}, 'delete', routine), 'routine-button routine-delete'); yes.dataset.confirmDelete = 'true';
        const no = button('취소', () => { active.confirmDelete = null; renderList(active); active.add.focus(); }); confirm.append(yes, no); card.append(confirm);
      }
      active.list.append(card);
    }
    if (active.busy) setBusy(active, true);
    else if (focusedAction) [...active.list.querySelectorAll('button')].find(item => item.dataset.routineAction === focusedAction && item.dataset.routineId === focusedId)?.focus();
  }
  function updateScheduleFields(active) {
    if (!active.fields) return;
    const type = active.fields.type.value;
    active.clockFields.hidden = type === 'interval'; active.weekFields.hidden = type !== 'weekly'; active.intervalField.hidden = type !== 'interval';
    active.fields.time.disabled = active.busy || type === 'interval'; active.fields.timezone.disabled = active.busy || type === 'interval';
    active.fields.minutes.disabled = active.busy || type !== 'interval';
    for (const day of active.fields.days) day.disabled = active.busy || type !== 'weekly';
  }
  function showEditor(active, routine = null) {
    if (!current(active) || active.busy) return;
    active.editing = routine; active.editor.hidden = false;
    active.editorTitle.textContent = routine ? '루틴 수정' : '새 루틴';
    const fields = active.fields, schedule = routine?.schedule || {type: 'daily', time: '09:00', timezone: 'Asia/Seoul'};
    fields.title.value = routine?.title || ''; fields.prompt.value = routine?.prompt || '';
    fields.type.value = schedule.type; fields.time.value = schedule.time || '09:00'; fields.timezone.value = schedule.timezone || 'Asia/Seoul';
    fields.minutes.value = String(schedule.everyMinutes || 60); fields.enabled.checked = routine?.enabled === true;
    for (const day of fields.days) day.checked = (schedule.daysOfWeek || [1, 2, 3, 4, 5]).includes(Number(day.value));
    const model = routine?.model ?? active.defaults.model ?? '';
    active.modelNote.textContent = `실행 모델: ${model || '자동 선택'}${(routine?.effort ?? active.defaults.effort) ? ` · ${routine?.effort ?? active.defaults.effort}` : ''}`;
    active.formStatus.textContent = ''; updateScheduleFields(active); fields.title.focus();
  }
  function buildEditor(active) {
    const editor = node('section', 'routine-editor'); editor.hidden = true;
    const title = node('h3', '', '새 루틴'); title.id = 'routine-editor-title';
    const form = node('form', 'routine-form'); form.setAttribute('aria-labelledby', title.id);
    const fields = {};
    const field = (text, control) => { const label = node('label', 'routine-field', text); label.append(control); return label; };
    fields.title = node('input'); fields.title.name = 'title'; fields.title.maxLength = 80; fields.title.placeholder = '예: 아침 일정 정리';
    fields.prompt = node('textarea'); fields.prompt.name = 'prompt'; fields.prompt.required = true; fields.prompt.maxLength = 4000; fields.prompt.rows = 4; fields.prompt.placeholder = '이 대화에 반복해서 보낼 메시지를 적어 주세요.';
    fields.type = node('select'); fields.type.name = 'type';
    for (const [value, text] of [['daily', '매일'], ['weekly', '요일별'], ['interval', '일정 간격']]) { const option = node('option', '', text); option.value = value; fields.type.append(option); }
    fields.type.addEventListener('change', () => updateScheduleFields(active));
    fields.time = node('input'); fields.time.type = 'time'; fields.time.name = 'time'; fields.time.required = true;
    fields.timezone = node('input'); fields.timezone.name = 'timezone'; fields.timezone.required = true; fields.timezone.placeholder = 'Asia/Seoul'; fields.timezone.maxLength = 80;
    const clockFields = node('div', 'routine-time-fields'); clockFields.append(field('시간', fields.time), field('시간대', fields.timezone));
    const weekFields = node('fieldset', 'routine-weekdays'); weekFields.append(node('legend', '', '반복할 요일'));
    fields.days = DAYS.map((day, i) => { const label = node('label', 'routine-day'), input = node('input'); input.type = 'checkbox'; input.value = String(i + 1); input.name = 'daysOfWeek'; label.append(input, node('span', '', day)); weekFields.append(label); return input; });
    fields.minutes = node('input'); fields.minutes.type = 'number'; fields.minutes.name = 'everyMinutes'; fields.minutes.min = '5'; fields.minutes.max = '10080'; fields.minutes.step = '1'; fields.minutes.required = true;
    const intervalField = field('간격 (분, 최소 5분)', fields.minutes);
    fields.enabled = node('input'); fields.enabled.type = 'checkbox'; fields.enabled.name = 'enabled';
    const enable = node('label', 'routine-enable'); enable.append(fields.enabled, node('span', '', '예약 켜기'));
    const modelNote = node('p', 'routine-meta');
    const status = node('p', 'routine-status'); status.setAttribute('role', 'alert');
    const actions = node('div', 'routine-form-actions');
    const cancel = button('취소', () => { if (active.busy) return; active.editor.hidden = true; active.form.reset(); active.editing = null; active.add.focus(); });
    const save = node('button', 'routine-button routine-primary', '저장'); save.type = 'submit'; actions.append(cancel, save);
    form.append(field('이름', fields.title), field('보낼 메시지', fields.prompt), field('반복', fields.type), clockFields, weekFields, intervalField, enable, modelNote, status, actions); editor.append(title, form);
    Object.assign(active, {editor, editorTitle: title, form, fields, clockFields, weekFields, intervalField, modelNote, formStatus: status});
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!current(active) || active.busy) return;
      try {
        const prompt = fields.prompt.value.trim(); if (!prompt) throw new Error('보낼 메시지를 입력해 주세요.');
        const schedule = validateRoutineSchedule({type: fields.type.value, time: fields.time.value, timezone: fields.timezone.value.trim(), daysOfWeek: fields.days.filter(day => day.checked).map(day => Number(day.value)), everyMinutes: Number(fields.minutes.value)});
        const payload = {title: fields.title.value.trim(), prompt, enabled: fields.enabled.checked, schedule, model: active.editing?.model ?? active.defaults.model ?? '', effort: active.editing?.effort ?? active.defaults.effort ?? ''};
        status.textContent = '';
        const path = active.editing ? `/api/routines/${encodeURIComponent(active.editing.id)}` : `/api/rooms/${encodeURIComponent(active.room.id)}/routines`;
        void mutate(active, path, {method: active.editing ? 'PATCH' : 'POST', body: JSON.stringify(payload)}, 'save', active.editing);
      } catch (error) { status.textContent = error.message; }
    });
    return editor;
  }
  function open(room = getRoom?.(), defaults = {}) {
    const user = getSession()?.user;
    if (!user || !roomId(room)) return;
    if (typeof room !== 'object') room = {id: room, name: '현재 대화'};
    close(); returnFocus = document.activeElement;
    if (!dialog) {
      dialog = node('dialog', 'routines-dialog'); dialog.setAttribute('aria-labelledby', 'routines-title');
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
      document.body.append(dialog);
    }
    const active = {generation, userId: user.id, room, defaults: {...defaults}, routines: [], runIds: new Map(), sequence: 0, busy: false, loaded: false}; view = active;
    const shell = node('div', 'routines-shell');
    const header = node('header', 'routines-header'), heading = node('div');
    const title = node('h2', '', '이 대화에서 반복 실행'); title.id = 'routines-title';
    heading.append(title, node('p', 'routine-room-name', room.name || '현재 대화'));
    const exit = button('×', close, 'routine-close'); exit.dataset.close = 'true'; exit.setAttribute('aria-label', '루틴 창 닫기'); header.append(heading, exit);
    const note = node('p', 'routines-description', '저장한 메시지를 이 대화에 보내 이어서 작업합니다. 창을 닫아도 예약은 유지됩니다.');
    const toolbar = node('div', 'routines-toolbar');
    active.add = button('+ 새 루틴', () => showEditor(active), 'routine-button routine-primary');
    const refresh = button('새로고침', () => void load(active)); toolbar.append(active.add, refresh);
    active.status = node('p', 'routine-status'); active.status.setAttribute('role', 'status');
    active.list = node('div', 'routine-list'); active.list.setAttribute('aria-label', '이 대화의 루틴');
    shell.append(header, note, toolbar, active.status, buildEditor(active), active.list); dialog.append(shell); dialog.showModal(); active.add.focus(); void load(active);
  }
  return {open, close, reset: close, destroy() { close(); dialog?.remove(); dialog = null; }};
}
