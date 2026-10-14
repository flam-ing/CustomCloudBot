import { randomUUID } from "node:crypto";

// A queued request contains user input and selection identifiers, never provider
// credentials. Claiming a request and inserting its human message share the
// server's SQLite transaction; a claimed request is never replayed on restart.
export function createMessageQueue(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS message_queue (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
    author_id TEXT NOT NULL REFERENCES users(id), author TEXT NOT NULL,
    nonce TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    message_id TEXT, error TEXT, UNIQUE(room_id,nonce));
    CREATE INDEX IF NOT EXISTS waiting_messages ON message_queue(state,priority,created_at);`);
  db.prepare("UPDATE message_queue SET state='interrupted',error='서버가 재시작되어 자동으로 다시 실행하지 않았습니다.' WHERE state='running'").run();
  const decode = row => row ? {...row, payload:JSON.parse(row.payload)} : null;
  const get = id => decode(db.prepare("SELECT * FROM message_queue WHERE id=?").get(id));
  function release(row) {
    for (const id of row.payload.attachmentIds) db.prepare("UPDATE attachments SET bound_at=NULL WHERE id=? AND room_id=? AND uploader_id=? AND NOT EXISTS (SELECT 1 FROM message_attachments WHERE attachment_id=?)").run(id,row.room_id,row.author_id,id);
  }
  return {
    get,
    existing(roomId,nonce) { return decode(db.prepare("SELECT * FROM message_queue WHERE room_id=? AND nonce=?").get(roomId,nonce)); },
    has(roomId) { return Boolean(db.prepare("SELECT 1 FROM message_queue WHERE room_id=? AND state='queued'").get(roomId)); },
    waiting(roomId) {
      return (roomId ? db.prepare("SELECT * FROM message_queue WHERE room_id=? AND state='queued' ORDER BY priority DESC,created_at,rowid").all(roomId) : db.prepare("SELECT * FROM message_queue WHERE state='queued' ORDER BY priority DESC,created_at,rowid").all()).map(decode);
    },
    enqueue({roomId,user,nonce,payload}) {
      if (db.prepare("SELECT count(*) n FROM message_queue WHERE state='queued'").get().n >= 100 || db.prepare("SELECT count(*) n FROM message_queue WHERE room_id=? AND state='queued'").get(roomId).n >= 20) throw Object.assign(new Error("대기 중인 메시지가 많습니다. 처리된 뒤 다시 보내 주세요."),{status:429});
      for (const id of payload.attachmentIds) {
        const held=db.prepare("UPDATE attachments SET bound_at=? WHERE id=? AND room_id=? AND uploader_id=? AND bound_at IS NULL").run(Date.now(),id,roomId,user.id);
        if(held.changes!==1) throw Object.assign(new Error("첨부 파일을 사용할 수 없습니다."),{status:400});
      }
      const id=randomUUID();
      db.prepare("INSERT INTO message_queue(id,room_id,author_id,author,nonce,payload,state,created_at) VALUES(?,?,?,?,?,?,'queued',?)").run(id,roomId,user.id,user.displayName,nonce,JSON.stringify(payload),Date.now());
      return get(id);
    },
    claim(id,messageId) {
      if(db.prepare("UPDATE message_queue SET state='running',message_id=? WHERE id=? AND state='queued'").run(messageId,id).changes!==1) throw Object.assign(new Error("대기 메시지가 이미 처리되었거나 취소되었습니다."),{status:409});
    },
    finish(id,state,error=null) { db.prepare("UPDATE message_queue SET state=?,error=? WHERE id=? AND state='running'").run(state,error,id); },
    continueWith(id,continuation,{botIds}={}) {
      const row=get(id);
      if(!row || row.state!=='queued') return false;
      row.payload.continuation=continuation;
      if(botIds) row.payload.botIds=[...botIds];
      return db.prepare("UPDATE message_queue SET payload=? WHERE id=? AND state='queued'").run(JSON.stringify(row.payload),id).changes===1;
    },
    remove(id,state='cancelled',error=null) {
      const row=get(id);
      if(!row || row.state!=='queued') return false;
      db.prepare("UPDATE message_queue SET state=?,error=? WHERE id=? AND state='queued'").run(state,error,id);
      release(row);
      return true;
    },
    prioritize(id) {
      // Priority only changes dispatch order. No active request is re-attributed
      // to the user who clicked the button.
      const priority=db.prepare("SELECT COALESCE(max(priority),0)+1 n FROM message_queue WHERE state='queued'").get().n;
      return db.prepare("UPDATE message_queue SET priority=? WHERE id=? AND state='queued'").run(priority,id).changes===1;
    },
  };
}
