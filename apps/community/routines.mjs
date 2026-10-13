import { createHash, randomUUID } from "node:crypto";
import { EFFORTS } from "./providers.mjs";

const MINUTE = 60000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const formatters = new Map();
function formatter(timezone) {
  if (!formatters.has(timezone)) {
    const result = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    result.format(0);
    if (formatters.size >= 100) formatters.delete(formatters.keys().next().value);
    formatters.set(timezone, result);
  }
  return formatters.get(timezone);
}
const parts = (at, timezone) => Object.fromEntries(formatter(timezone).formatToParts(at).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
function text(value, limit, fallback = "") {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > limit || /[\u0000]/.test(value)) throw fail("루틴 입력의 형식이나 길이를 확인해주세요.");
  return value.trim();
}

export function normalizeRoutineSchedule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("반복 일정을 선택해주세요.");
  const timezone = text(input.timezone, 100, "Asia/Seoul");
  try { formatter(timezone); } catch { throw fail("올바른 IANA 시간대를 입력해주세요."); }
  if (input.type === "interval") {
    if (!Number.isInteger(input.everyMinutes) || input.everyMinutes < 5 || input.everyMinutes > 10080) throw fail("반복 간격은 5분~7일 사이여야 합니다.");
    return { type: "interval", everyMinutes: input.everyMinutes, timezone };
  }
  if (!["daily", "weekly"].includes(input.type) || typeof input.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw fail("실행 시각을 HH:mm 형식으로 입력해주세요.");
  const schedule = { type: input.type, time: input.time, timezone };
  if (input.type === "weekly") {
    if (!Array.isArray(input.daysOfWeek) || !input.daysOfWeek.length || input.daysOfWeek.length > 7 || input.daysOfWeek.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw fail("반복할 요일을 선택해주세요.");
    schedule.daysOfWeek = [...new Set(input.daysOfWeek)].sort((a, b) => a - b);
  }
  return schedule;
}

// Missing wall times (DST spring gap) are skipped. Repeated wall times use only
// the first occurrence, so a daily routine still runs at most once that date.
export function nextRoutineAt(input, after) {
  const schedule = normalizeRoutineSchedule(input), at = Number(after);
  if (!Number.isFinite(at)) throw fail("기준 시각이 올바르지 않습니다.");
  if (schedule.type === "interval") return at + schedule.everyMinutes * MINUTE;
  const local = parts(at, schedule.timezone), [hour, minute] = schedule.time.split(":").map(Number);
  for (let day = 0; day < 15; day++) {
    const calendar = new Date(Date.UTC(local.year, local.month - 1, local.day + day));
    const weekday = calendar.getUTCDay() || 7;
    if (schedule.type === "weekly" && !schedule.daysOfWeek.includes(weekday)) continue;
    const wall = Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate(), hour, minute);
    const offsets = new Set();
    for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
      const sample = wall + hours * 3600000, value = parts(sample, schedule.timezone);
      offsets.add(Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute) - sample);
    }
    const candidates = [...offsets].map(offset => wall - offset).filter(candidate => {
      const value = parts(candidate, schedule.timezone);
      return value.year === calendar.getUTCFullYear() && value.month === calendar.getUTCMonth() + 1 && value.day === calendar.getUTCDate() && value.hour === hour && value.minute === minute;
    }).sort((a, b) => a - b);
    if (candidates.length && candidates[0] > at) return candidates[0];
  }
  throw fail("다음 실행 시각을 계산하지 못했습니다.");
}

/** Persistent, owner-scoped schedules. A dispatch is never retried unless its
 * callback explicitly certifies no side effect occurred (safeToRetry=true). */
export function createRoutines({ db, authorize, dispatch, now = Date.now, pollIntervalMs = 15000, dispatchTimeoutMs = 180000 }) {
  if (!db || typeof authorize !== "function" || typeof dispatch !== "function") throw new TypeError("Routine dependencies are required");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > MINUTE) throw new TypeError("Invalid routine poll interval");
  if (!Number.isInteger(dispatchTimeoutMs) || dispatchTimeoutMs < 1 || dispatchTimeoutMs > 300000) throw new TypeError("Invalid routine dispatch timeout");
  const instance = randomUUID(), leaseMs = Math.max(120000, pollIntervalMs * 4);
  let timer = null, pending = null, active = null, closed = false;
  const timestamp = () => { const value = Number(now()); if (!Number.isSafeInteger(value)) throw new Error("Invalid routine clock"); return value; };
  db.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, room_id TEXT NOT NULL, title TEXT NOT NULL,
      prompt TEXT NOT NULL, schedule TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
      enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      next_run_at INTEGER, deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS routines_owner ON routines(owner_id,room_id,deleted_at);
    CREATE TABLE IF NOT EXISTS routine_runs (
      id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routines(id), occurrence_key TEXT NOT NULL,
      kind TEXT NOT NULL, scheduled_at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
      ready_at INTEGER NOT NULL, lease_token TEXT, message_id TEXT,
      UNIQUE(routine_id,occurrence_key)
    );
    CREATE INDEX IF NOT EXISTS routine_runs_pending ON routine_runs(status,ready_at);
    CREATE UNIQUE INDEX IF NOT EXISTS routine_one_pending ON routine_runs(routine_id) WHERE status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS routine_scheduler_lock(id INTEGER PRIMARY KEY CHECK(id=1),holder TEXT NOT NULL,lease_until INTEGER NOT NULL);
    INSERT OR IGNORE INTO routine_scheduler_lock VALUES(1,'',0);
  `);
  function transaction(fn) { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } }
  function rowFor(ownerId, id) {
    const row = db.prepare("SELECT * FROM routines WHERE id=? AND owner_id=? AND deleted_at IS NULL").get(id, ownerId);
    if (!row) throw fail("루틴을 찾을 수 없습니다.", 404);
    return row;
  }
  async function permit(ownerId, roomId) {
    if (await authorize(ownerId, roomId) === false) throw fail("이 대화에서 루틴을 사용할 수 없습니다.", 403);
  }
  const runView = run => ({ id:run.id, kind:run.kind, status:run.status, reason:run.reason, scheduledAt:run.scheduled_at, createdAt:run.created_at, startedAt:run.started_at, finishedAt:run.finished_at, messageId:run.message_id || null });
  function view(row) {
    const runs = db.prepare("SELECT * FROM routine_runs WHERE routine_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10").all(row.id);
    const last = runs[0];
    return { id:row.id, ownerId:row.owner_id, roomId:row.room_id, title:row.title, prompt:row.prompt, schedule:JSON.parse(row.schedule), model:row.model, effort:row.effort,
      enabled:Boolean(row.enabled), createdAt:row.created_at, updatedAt:row.updated_at, nextRunAt:row.next_run_at,
      lastRunAt:last?.started_at || null, lastStatus:last?.status || null, lastReason:last?.reason || null,
      runs:runs.map(runView), dstPolicy:"skip-missing-once-per-day" };
  }
  function normalize(input, previous) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["title","prompt","schedule","model","effort","enabled"].includes(key))) throw fail("루틴 설정을 확인해주세요.");
    const prior = previous ? view(previous) : {};
    const prompt = text(input.prompt, 4000, prior.prompt);
    if (!prompt) throw fail("예약할 메시지를 입력해주세요.");
    const title = text(input.title, 80, prior.title || prompt.replace(/\s+/g," ").slice(0,40));
    const model = text(input.model, 200, prior.model || ""), effort = text(input.effort, 16, prior.effort || "");
    if (effort && !EFFORTS.includes(effort)) throw fail("모델의 사고 수준을 확인해주세요.");
    const enabled = Object.hasOwn(input,"enabled") ? input.enabled : prior.enabled ?? false;
    if (typeof enabled !== "boolean") throw fail("루틴의 실행 여부를 확인해주세요.");
    return { title, prompt, schedule:normalizeRoutineSchedule(input.schedule ?? prior.schedule), model, effort, enabled };
  }
  function cap(ownerId, excluding = "") {
    if (db.prepare("SELECT count(*) n FROM routines WHERE owner_id=? AND deleted_at IS NULL AND id!=?").get(ownerId, excluding).n >= 20) throw fail("루틴은 사용자당 최대 20개입니다.", 409);
  }
  const nonce = (id, key) => createHash("sha256").update("routine:"+id+":"+key).digest("hex");
  function enqueue(row, key, kind, at, status = "queued", reason = "") {
    const id = nonce(row.id, key), time = timestamp();
    db.prepare("INSERT OR IGNORE INTO routine_runs(id,routine_id,occurrence_key,kind,scheduled_at,status,reason,payload,created_at,finished_at,ready_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id,row.id,key,kind,at,status,reason,JSON.stringify(view(row)),time,status === "skipped" ? time : null,time);
    return db.prepare("SELECT * FROM routine_runs WHERE id=?").get(id);
  }
  function finish(id, status, reason = "", messageId = null) {
    db.prepare("UPDATE routine_runs SET status=?,reason=?,finished_at=?,message_id=? WHERE id=? AND status='running' AND lease_token=?")
      .run(status,reason,timestamp(),typeof messageId === "string" ? messageId.slice(0,100) : null,id,instance);
  }
  function cancelQueued(id, reason) { db.prepare("UPDATE routine_runs SET status='skipped',reason=?,finished_at=? WHERE routine_id=? AND status='queued'").run(reason,timestamp(),id); }
  function acquire() {
    return transaction(() => {
      const time = timestamp();
      if (!db.prepare("UPDATE routine_scheduler_lock SET holder=?,lease_until=? WHERE id=1 AND (lease_until<=? OR holder=?)").run(instance,time+leaseMs,time,instance).changes) return false;
      // Only the winning lease holder can recover crashed work. A second server
      // must not interrupt an active dispatch owned by the first server.
      // No dispatch in this instance is active when a new tick acquires its
      // lease. Also recover a prior tick interrupted by a transient DB error.
      db.prepare("UPDATE routine_runs SET status='interrupted',reason='server_restarted',finished_at=? WHERE status='running'").run(time);
      return true;
    });
  }
  function ownsLease() { const lock=db.prepare("SELECT holder,lease_until FROM routine_scheduler_lock WHERE id=1").get(); return lock.holder===instance && lock.lease_until>timestamp(); }
  function materialize() {
    const time=timestamp();
    for (const row of db.prepare("SELECT * FROM routines WHERE enabled=1 AND deleted_at IS NULL AND next_run_at<=? ORDER BY next_run_at,id").all(time)) {
      const next=nextRoutineAt(JSON.parse(row.schedule),time);
      const inFlight=Boolean(db.prepare("SELECT 1 FROM routine_runs WHERE routine_id=? AND status IN ('queued','running')").get(row.id));
      const missed=time-row.next_run_at>Math.max(MINUTE,pollIntervalMs*2);
      enqueue(row,"scheduled:"+row.next_run_at,"scheduled",row.next_run_at,inFlight || missed ? "skipped" : "queued",inFlight ? "previous_run_pending" : missed ? "missed_schedule" : "");
      db.prepare("UPDATE routines SET next_run_at=? WHERE id=?").run(next,row.id);
    }
  }
  async function execute(job) {
    const controller=new AbortController();
    active={id:job.routine_id,controller};
    let timeout, abortListener;
    try {
      const row=db.prepare("SELECT * FROM routines WHERE id=?").get(job.routine_id);
      if (!row || row.deleted_at || (job.kind === "scheduled" && !row.enabled)) { finish(job.id,"skipped","routine_paused"); return; }
      try { await permit(row.owner_id,row.room_id); }
      catch { db.prepare("UPDATE routines SET enabled=0,next_run_at=NULL,updated_at=? WHERE id=?").run(timestamp(),row.id); finish(job.id,"skipped","access_revoked"); return; }
      if (closed || controller.signal.aborted || !ownsLease()) { finish(job.id,"interrupted","execution_stopped"); return; }
      const routine=JSON.parse(job.payload);
      const deadline=new Promise((_,reject)=>{ timeout=setTimeout(()=>{ controller.abort(); reject(Object.assign(new Error("dispatch timeout"),{routineTimeout:true})); },dispatchTimeoutMs); timeout.unref?.(); });
      const aborted=new Promise((_,reject)=>{ abortListener=()=>reject(new Error("dispatch interrupted"));controller.signal.addEventListener("abort",abortListener,{once:true}); });
      const result=await Promise.race([dispatch({routine,occurrenceId:job.id,signal:controller.signal}),deadline,aborted]);
      finish(job.id,"submitted","",result?.messageId);
    } catch (error) {
      const latest=db.prepare("SELECT enabled,deleted_at FROM routines WHERE id=?").get(job.routine_id);
      if (error?.safeToRetry === true && !closed && !controller.signal.aborted && latest && !latest.deleted_at && (job.kind === "manual" || latest.enabled) && ownsLease()) {
        if (timestamp()-job.created_at>=86400000) finish(job.id,"skipped","busy_expired");
        else db.prepare("UPDATE routine_runs SET status='queued',reason='room_busy',ready_at=?,started_at=NULL,lease_token=NULL WHERE id=? AND status='running' AND lease_token=?").run(timestamp()+30000,job.id,instance);
      } else finish(job.id,controller.signal.aborted || error?.routineTimeout ? "interrupted" : "failed",controller.signal.aborted || error?.routineTimeout ? "execution_stopped" : "dispatch_failed");
    } finally { clearTimeout(timeout);if(abortListener)controller.signal.removeEventListener("abort",abortListener);active=null; }
  }
  async function work() {
    if (closed || !acquire()) return;
    const heartbeat=setInterval(()=>{
      try { if (!db.prepare("UPDATE routine_scheduler_lock SET lease_until=? WHERE id=1 AND holder=?").run(timestamp()+leaseMs,instance).changes) active?.controller.abort(); }
      catch { active?.controller.abort(); }
    },Math.min(20000,leaseMs/3));
    heartbeat.unref?.();
    try {
      transaction(materialize);
      for(let count=0;count<10 && !closed && ownsLease();count++) {
        const job=transaction(()=>{
          const row=db.prepare("SELECT * FROM routine_runs WHERE status='queued' AND ready_at<=? ORDER BY ready_at,created_at,id LIMIT 1").get(timestamp());
          if (!row) return null;
          return db.prepare("UPDATE routine_runs SET status='running',started_at=?,lease_token=? WHERE id=? AND status='queued'").run(timestamp(),instance,row.id).changes ? row : null;
        });
        if (!job) break;
        await execute(job);
      }
    } finally { clearInterval(heartbeat); db.prepare("UPDATE routine_scheduler_lock SET holder='',lease_until=0 WHERE id=1 AND holder=?").run(instance); }
  }
  function tick() {
    if (closed) return Promise.resolve();
    if (!pending) pending=work().finally(()=>{pending=null;});
    return pending;
  }
  return {
    async list(ownerId,roomId) { await permit(ownerId,roomId); return db.prepare("SELECT * FROM routines WHERE owner_id=? AND room_id=? AND deleted_at IS NULL ORDER BY created_at,id").all(ownerId,roomId).map(view); },
    async create(ownerId,roomId,input) {
      await permit(ownerId,roomId);
      const value=normalize(input),time=timestamp(),id=randomUUID();
      transaction(()=>{ cap(ownerId); db.prepare("INSERT INTO routines VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)").run(id,ownerId,roomId,value.title,value.prompt,JSON.stringify(value.schedule),value.model,value.effort,Number(value.enabled),time,time,value.enabled?nextRoutineAt(value.schedule,time):null); });
      return view(rowFor(ownerId,id));
    },
    async update(ownerId,id,input) {
      const row=rowFor(ownerId,id);await permit(ownerId,row.room_id);
      const value=normalize(input,row),time=timestamp();
      transaction(()=>{
        cancelQueued(id,value.enabled ? "routine_changed" : "routine_paused");
        const changed=JSON.stringify(value.schedule)!==row.schedule;
        const next=value.enabled ? (!row.enabled || changed ? nextRoutineAt(value.schedule,time) : row.next_run_at) : null;
        db.prepare("UPDATE routines SET title=?,prompt=?,schedule=?,model=?,effort=?,enabled=?,next_run_at=?,updated_at=? WHERE id=? AND owner_id=? AND deleted_at IS NULL").run(value.title,value.prompt,JSON.stringify(value.schedule),value.model,value.effort,Number(value.enabled),next,time,id,ownerId);
      });
      if (!value.enabled && active?.id===id) active.controller.abort();
      return view(rowFor(ownerId,id));
    },
    async remove(ownerId,id) {
      const row=rowFor(ownerId,id);await permit(ownerId,row.room_id);
      transaction(()=>{ db.prepare("UPDATE routines SET deleted_at=?,updated_at=?,enabled=0,next_run_at=NULL WHERE id=? AND owner_id=?").run(timestamp(),timestamp(),id,ownerId);cancelQueued(id,"routine_deleted"); });
      if (active?.id===id) active.controller.abort();
      return {deleted:true};
    },
    async runNow(ownerId,id,{requestId=randomUUID()}={}) {
      const row=rowFor(ownerId,id);await permit(ownerId,row.room_id);
      const key="manual:"+text(requestId,128);
      if (key==='manual:') throw fail("실행 요청 ID를 확인해주세요.");
      const job=transaction(()=>{
        const existing=db.prepare("SELECT * FROM routine_runs WHERE routine_id=? AND occurrence_key=?").get(id,key);
        if(existing)return existing;
        if(db.prepare("SELECT 1 FROM routine_runs WHERE routine_id=? AND status IN ('queued','running')").get(id))throw fail("이미 대기하거나 실행 중인 루틴입니다.",409);
        return enqueue(row,key,"manual",timestamp());
      });
      queueMicrotask(()=>{ void tick().catch(()=>{}); });
      return {routine:view(rowFor(ownerId,id)),run:runView(job)};
    },
    tick,
    start() { if(!closed && !timer){timer=setInterval(()=>{void tick().catch(()=>{});},pollIntervalMs);timer.unref?.();void tick().catch(()=>{});} },
    async close() {closed=true;clearInterval(timer);timer=null;active?.controller.abort();if(pending)await pending;},
  };
}
