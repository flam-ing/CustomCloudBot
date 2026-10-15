import {createHash} from 'node:crypto';

const failure = (status, message) => Object.assign(new Error(message), {status});
const EMAIL_DELAY = 60_000;
const EMAIL_INTERVAL = 5 * 60_000;
const RETRY_WINDOW = 23 * 60 * 60_000;
const titles = {human:'새 메시지가 도착했습니다.', bot:'봇 답변이 도착했습니다.', system:'대화에 확인할 알림이 있습니다.'};
const emailPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

/** Per-user generic notices. Chat contents never enter this store or an alert email. */
export function createNotifications({db, mailbox, roomFor, canEmailRoom = () => true,
  getName = () => 'CustomCloudBot', getOrigin = () => '', now = Date.now,
  emailDelay = EMAIL_DELAY, emailInterval = EMAIL_INTERVAL} = {}) {
  if (!db || typeof roomFor !== 'function') throw new TypeError('Notification dependencies are required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      sound_enabled INTEGER NOT NULL DEFAULT 1, email_enabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS notification_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, room_id TEXT NOT NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
      email_state TEXT NOT NULL DEFAULT 'none', email_to TEXT NOT NULL DEFAULT '',
      email_request_id TEXT NOT NULL, email_subject TEXT NOT NULL DEFAULT '', email_text TEXT NOT NULL DEFAULT '',
      email_attempts INTEGER NOT NULL DEFAULT 0, email_first_attempt_at INTEGER,
      email_last_attempt_at INTEGER, email_next_attempt_at INTEGER NOT NULL,
      UNIQUE(user_id,id)
    );
    CREATE INDEX IF NOT EXISTS notifications_user_feed ON notification_events(user_id,sequence);
    CREATE INDEX IF NOT EXISTS notifications_email_queue ON notification_events(email_state,email_next_attempt_at);
    CREATE INDEX IF NOT EXISTS notifications_email_room ON notification_events(user_id,room_id,email_last_attempt_at);
  `);
  // Retry the same persisted request after an interrupted delivery; never issue a new identity.
  db.prepare("UPDATE notification_events SET email_state='retry' WHERE email_state='sending'").run();
  let closed = false, timer = null, processing = null;
  const clock = () => Math.floor(Number(now()));
  const userById = id => db.prepare('SELECT id,role FROM users WHERE id=?').get(id);
  function accessible(user, roomId) {
    try { return roomFor(roomId, user); } catch { return null; }
  }
  function mappedEmail(userId) {
    let senders;
    try { senders = JSON.parse(db.prepare('SELECT senders FROM mail_agent_config WHERE id=1').get()?.senders || '[]'); }
    catch { return ''; }
    if (!Array.isArray(senders)) return '';
    const row = senders.find(item => item?.userId === userId && typeof item.email === 'string' && item.email.length <= 254 && emailPattern.test(item.email));
    return row?.email.trim().toLowerCase() || '';
  }
  function settings(user) {
    const prefs = db.prepare('SELECT * FROM notification_preferences WHERE user_id=?').get(user.id);
    const emailAddress = mappedEmail(user.id);
    return {soundEnabled:prefs ? Boolean(prefs.sound_enabled) : true,
      emailEnabled:Boolean(prefs?.email_enabled), emailAddress,
      emailConfigured:Boolean(mailbox?.configured && emailAddress)};
  }
  function configure(user, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !['soundEnabled','emailEnabled'].some(key => Object.hasOwn(input,key)) ||
      Object.keys(input).some(key => !['soundEnabled','emailEnabled'].includes(key) || typeof input[key] !== 'boolean'))
      throw failure(400, '알림 설정을 확인해 주세요.');
    const current = settings(user), next = {...current,...input};
    if (input.emailEnabled === true && !current.emailConfigured) throw failure(409, '등록된 이메일과 메일 연결을 먼저 확인해 주세요.');
    db.prepare(`INSERT INTO notification_preferences(user_id,sound_enabled,email_enabled) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET sound_enabled=excluded.sound_enabled,email_enabled=excluded.email_enabled`)
      .run(user.id, Number(next.soundEnabled), Number(next.emailEnabled));
    if (!next.emailEnabled) db.prepare("UPDATE notification_events SET email_state='suppressed' WHERE user_id=? AND email_state IN ('pending','retry')").run(user.id);
    return settings(user);
  }
  function emit({roomId, messageId, kind, authorId = null}) {
    if (closed || !titles[kind] || typeof messageId !== 'string' || !messageId) return;
    const eventId = `message:${roomId}:${messageId}`, at = clock();
    const members = db.prepare('SELECT u.id,u.role FROM room_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=?').all(roomId);
    for (const user of members) {
      if (kind === 'human' && user.id === authorId) continue;
      const room = accessible(user, roomId);
      if (!room) continue;
      const prefs = settings(user), sendEmail = prefs.emailEnabled && prefs.emailConfigured && canEmailRoom(room);
      const requestId = 'notification-' + createHash('sha256').update(user.id + '\0' + eventId).digest('hex');
      db.prepare(`INSERT OR IGNORE INTO notification_events
        (id,user_id,room_id,kind,title,created_at,email_state,email_to,email_request_id,email_next_attempt_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(eventId,user.id,roomId,kind,titles[kind],at,
          sendEmail ? 'pending' : 'none',sendEmail ? prefs.emailAddress : '',requestId,at + emailDelay);
    }
  }
  function list(user, after = null) {
    if (after !== null && (!/^(0|[1-9]\d*)$/.test(String(after)) || !Number.isSafeInteger(Number(after))))
      throw failure(400, '알림 목록 위치가 올바르지 않습니다.');
    const rows = after === null
      ? db.prepare('SELECT * FROM notification_events WHERE user_id=? ORDER BY sequence DESC LIMIT 50').all(user.id).reverse()
      : db.prepare('SELECT * FROM notification_events WHERE user_id=? AND sequence>? ORDER BY sequence LIMIT 100').all(user.id,Number(after));
    const cursor = rows.at(-1)?.sequence ?? (after === null ? 0 : Number(after));
    const items = rows.flatMap(row => {
      const room = accessible(user,row.room_id);
      return room ? [{id:row.id,sequence:row.sequence,roomId:row.room_id,roomName:room.name,kind:row.kind,
        title:row.title,at:row.created_at,read:row.read_at !== null}] : [];
    });
    return {items,cursor};
  }
  function markRead(user, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure(400, '읽을 알림을 선택해 주세요.');
    const choices = ['ids','roomId','all'].filter(key => Object.hasOwn(input,key));
    if (choices.length !== 1 || Object.keys(input).some(key => !choices.includes(key))) throw failure(400, '읽을 알림을 선택해 주세요.');
    let rows;
    if (choices[0] === 'ids') {
      if (!Array.isArray(input.ids) || input.ids.length > 200 || input.ids.some(id => typeof id !== 'string' || id.length > 250)) throw failure(400, '알림 번호를 확인해 주세요.');
      rows = [...new Set(input.ids)].map(id => db.prepare('SELECT * FROM notification_events WHERE user_id=? AND id=? AND read_at IS NULL').get(user.id,id)).filter(Boolean);
    } else if (choices[0] === 'roomId') {
      if (typeof input.roomId !== 'string' || !accessible(user,input.roomId)) throw failure(404, '방을 찾을 수 없습니다.');
      rows = db.prepare('SELECT * FROM notification_events WHERE user_id=? AND room_id=? AND read_at IS NULL').all(user.id,input.roomId);
    } else {
      if (input.all !== true) throw failure(400, '읽을 알림을 선택해 주세요.');
      rows = db.prepare('SELECT * FROM notification_events WHERE user_id=? AND read_at IS NULL').all(user.id);
    }
    let read = 0;
    for (const row of rows) if (accessible(user,row.room_id)) {
      read += db.prepare(`UPDATE notification_events SET read_at=?,email_state=CASE WHEN email_state IN ('pending','retry') THEN 'suppressed' ELSE email_state END
        WHERE sequence=? AND user_id=? AND read_at IS NULL`).run(clock(),row.sequence,user.id).changes;
    }
    return {read};
  }
  const setState = (sequence,state) => db.prepare('UPDATE notification_events SET email_state=? WHERE sequence=?').run(state,sequence);
  function permitted(row) {
    if (closed) return false;
    const user = userById(row.user_id);
    if (!user) return false;
    const prefs = settings(user), room = accessible(user,row.room_id);
    return row.read_at === null && prefs.emailEnabled && prefs.emailConfigured &&
      prefs.emailAddress === row.email_to && room && canEmailRoom(room);
  }
  function emailBody(row) {
    const name = String(getName()).replace(/[\r\n]/g,' ').slice(0,100) || 'CustomCloudBot';
    let link = '';
    try {
      const url = new URL(getOrigin());
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        url.pathname='/';url.search='';url.hash='';url.username='';url.password='';
        url.searchParams.set('room',row.room_id);link='\n\n'+url.href;
      }
    } catch {}
    return {subject:`${name} · 새 알림`,text:`읽지 않은 대화 알림이 있습니다. 앱에서 확인해 주세요.${link}\n\n메일 알림은 앱의 알림 설정에서 끌 수 있습니다.`};
  }
  async function deliver() {
    if (closed) return;
    const oldest = clock()-30*86400_000;
    db.prepare("UPDATE notification_events SET email_state='suppressed' WHERE email_state='pending' AND created_at<?").run(clock()-RETRY_WINDOW);
    db.prepare("UPDATE notification_events SET email_state='uncertain' WHERE email_state='retry' AND email_first_attempt_at<?").run(clock()-RETRY_WINDOW);
    db.prepare("DELETE FROM notification_events WHERE created_at<? AND email_state NOT IN ('pending','sending','retry')").run(oldest);
    if (!mailbox?.configured) return;
    const due = db.prepare(`SELECT e.* FROM notification_events e WHERE e.email_next_attempt_at<=? AND (
      e.email_state='retry' OR (e.email_state='pending'
        AND NOT EXISTS(SELECT 1 FROM notification_events active WHERE active.user_id=e.user_id AND active.room_id=e.room_id AND active.email_state IN ('sending','retry'))
        AND e.sequence=(SELECT min(first.sequence) FROM notification_events first WHERE first.user_id=e.user_id AND first.room_id=e.room_id AND first.email_state='pending')))
      ORDER BY CASE e.email_state WHEN 'retry' THEN 0 ELSE 1 END,e.sequence LIMIT 100`).all(clock());
    for (const candidate of due) {
      if (closed) break;
      const row = db.prepare('SELECT * FROM notification_events WHERE sequence=?').get(candidate.sequence);
      if (!row || !['pending','retry'].includes(row.email_state)) continue;
      if (!permitted(row)) {setState(row.sequence,'suppressed');continue;}
      if (row.email_attempts >= 5 || (row.email_first_attempt_at !== null && clock()-row.email_first_attempt_at >= RETRY_WINDOW)) {
        setState(row.sequence,'uncertain');continue;
      }
      // An unresolved delivery owns this room's email slot until it finishes.
      if (db.prepare("SELECT 1 FROM notification_events WHERE user_id=? AND room_id=? AND sequence!=? AND email_state IN ('sending','retry') LIMIT 1")
        .get(row.user_id,row.room_id,row.sequence)) continue;
      const last = db.prepare('SELECT max(email_last_attempt_at) at FROM notification_events WHERE user_id=? AND room_id=?').get(row.user_id,row.room_id).at;
      if (last !== null && clock()-last < emailInterval) {
        db.prepare('UPDATE notification_events SET email_next_attempt_at=? WHERE sequence=?').run(last+emailInterval,row.sequence);
        continue;
      }
      const at = clock(), content = row.email_subject ? {subject:row.email_subject,text:row.email_text} : emailBody(row);
      db.prepare(`UPDATE notification_events SET email_state='sending',email_attempts=email_attempts+1,
        email_first_attempt_at=COALESCE(email_first_attempt_at,?),email_last_attempt_at=?,email_subject=?,email_text=? WHERE sequence=?`)
        .run(at,at,content.subject,content.text,row.sequence);
      try {
        const result = await mailbox.send({action:'send',to:row.email_to,...content,requestId:row.email_request_id,automatic:true});
        if (result?.accepted !== true) throw new Error('Delivery not confirmed');
        setState(row.sequence,'sent');
        // One generic email covers the unread notices already present in this room.
        db.prepare("UPDATE notification_events SET email_state='suppressed' WHERE user_id=? AND room_id=? AND email_state='pending' AND created_at<=?")
          .run(row.user_id,row.room_id,at);
      } catch {
        const attempts = row.email_attempts + 1;
        db.prepare('UPDATE notification_events SET email_state=?,email_next_attempt_at=? WHERE sequence=?')
          .run(attempts >= 5 ? 'uncertain' : 'retry',clock()+Math.min(3_600_000,emailInterval*2**(attempts-1)),row.sequence);
      }
    }
  }
  function poll() {
    if (processing) return processing;
    processing = deliver().finally(() => {processing=null;});
    return processing;
  }
  function start() {
    if (timer || closed) return;
    timer = setInterval(() => {void poll().catch(() => {});},10_000);timer.unref?.();
  }
  async function close() {
    closed=true;clearInterval(timer);timer=null;
    await processing;
  }
  return {settings,configure,emit,list,markRead,poll,start,close};
}
