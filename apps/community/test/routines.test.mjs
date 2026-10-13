import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRoutines, nextRoutineAt, normalizeRoutineSchedule } from "../routines.mjs";

const base = Date.parse("2026-10-13T00:00:00Z");
const interval = { type:"interval", everyMinutes:5 };
const utc = date => Date.parse(date);
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options={}) {
  const db=new DatabaseSync(":memory:");
  let time=base,allowed=true;
  const calls=[];
  const dispatch=async value=>{ calls.push(value);return options.dispatch ? options.dispatch(value) : {messageId:"message-1"}; };
  const make=()=>createRoutines({db,now:()=>time,authorize:async()=>allowed,dispatch,...options.factory});
  const api=make();
  t.after(async()=>{await api.close();db.close();});
  return {db,api,calls,make,setTime(value){time=value;},advance(value){time+=value;},allow(value){allowed=value;}};
}
const create = (f, input={})=>f.api.create("owner","room",{prompt:"CHECK_THIS_ROOM",schedule:interval,...input});

test("daily and weekly schedules use IANA local time and Monday=1 through Sunday=7",()=>{
  assert.equal(nextRoutineAt({type:"daily",time:"09:00"},utc("2026-10-12T23:59:59Z")),utc("2026-10-13T00:00:00Z"));
  assert.equal(nextRoutineAt({type:"daily",time:"09:00"},base),utc("2026-10-14T00:00:00Z"));
  assert.equal(nextRoutineAt({type:"weekly",time:"09:00",daysOfWeek:[1]},base),utc("2026-10-19T00:00:00Z"));
  assert.equal(nextRoutineAt({type:"weekly",time:"10:30",timezone:"Asia/Kathmandu",daysOfWeek:[7,7]},base),utc("2026-10-18T04:45:00Z"));
  assert.equal(nextRoutineAt(interval,base),base+300000);
  assert.throws(()=>normalizeRoutineSchedule({type:"interval",everyMinutes:4}),/반복 간격/);
  assert.throws(()=>normalizeRoutineSchedule({type:"daily",time:"24:01"}),/HH:mm/);
  assert.throws(()=>normalizeRoutineSchedule({type:"daily",time:"09:00",timezone:"Unknown/Zone"}),/시간대/);
  assert.throws(()=>normalizeRoutineSchedule({type:"weekly",time:"09:00",daysOfWeek:[0]}),/요일/);
});

test("DST gaps are skipped and repeated local time runs only at its first occurrence",()=>{
  const spring={type:"daily",time:"02:30",timezone:"America/New_York"};
  assert.equal(nextRoutineAt(spring,utc("2026-03-08T05:00:00Z")),utc("2026-03-09T06:30:00Z"));
  const fall={type:"daily",time:"01:30",timezone:"America/New_York"};
  assert.equal(nextRoutineAt(fall,utc("2026-11-01T04:00:00Z")),utc("2026-11-01T05:30:00Z"));
  assert.equal(nextRoutineAt(fall,utc("2026-11-01T05:30:00Z")),utc("2026-11-02T06:30:00Z"));
  assert.equal(nextRoutineAt(fall,utc("2026-11-01T06:00:00Z")),utc("2026-11-02T06:30:00Z"));
});

test("routines default paused, validate scope and content, and enforce an owner cap",async t=>{
  const f=fixture(t),routine=await create(f);
  assert.equal(routine.enabled,false);assert.equal(routine.nextRunAt,null);
  await f.api.tick();assert.equal(f.calls.length,0);
  await assert.rejects(create(f,{prompt:"x".repeat(4001)}),/길이/);
  await assert.rejects(create(f,{enabled:null}),/실행 여부/);
  await assert.rejects(f.api.update("owner",routine.id,{roomId:"another-room"}),/설정/);
  await assert.rejects(f.api.update("other",routine.id,{enabled:true}),{status:404});
  await assert.rejects(f.api.runNow("other",routine.id),{status:404});
  for(let i=1;i<20;i++)await create(f);
  await assert.rejects(create(f),{status:409});
  await f.api.remove("owner",routine.id);
  await create(f);
  assert.equal((await f.api.list("owner","room")).length,20);
  assert.equal((await f.api.list("other","room")).length,0);
});

test("overlapping ticks and a second scheduler cannot dispatch the same occurrence",async t=>{
  const done=Promise.withResolvers();
  const f=fixture(t,{dispatch:()=>done.promise});
  const routine=await create(f,{enabled:true});
  f.setTime(routine.nextRunAt);
  const first=f.api.tick(),again=f.api.tick();
  assert.equal(first,again);
  await settle();
  const second=f.make();
  await second.tick();
  assert.equal(f.calls.length,1);
  assert.match(f.calls[0].occurrenceId,/^[a-f0-9]{64}$/);
  assert.equal(f.calls[0].routine.roomId,"room");
  assert.equal(f.db.prepare("SELECT status FROM routine_runs").get().status,"running");
  done.resolve({messageId:"accepted"});await first;
  await second.tick();
  assert.equal(f.calls.length,1);
  assert.equal((await f.api.list("owner","room"))[0].lastStatus,"submitted");
  await second.close();
});

test("restart never replays an uncertain running job and missed schedules do not catch up in a burst",async t=>{
  const f=fixture(t),routine=await create(f,{enabled:true});
  f.setTime(routine.nextRunAt);await f.api.tick();
  assert.equal(f.calls.length,1);
  f.db.prepare("UPDATE routine_runs SET status='running',lease_token='crashed-process',finished_at=NULL").run();
  f.db.prepare("UPDATE routine_scheduler_lock SET holder='crashed-process',lease_until=0").run();
  const restarted=f.make();
  await restarted.tick();
  assert.equal(f.calls.length,1);
  assert.equal(f.db.prepare("SELECT status,reason FROM routine_runs").get().status,"interrupted");
  f.advance(7*86400000);await restarted.tick();
  assert.equal(f.calls.length,1);
  const updated=(await restarted.list("owner","room"))[0];
  assert.equal(updated.lastReason,"missed_schedule");
  assert.ok(updated.nextRunAt>routine.nextRunAt+7*86400000);
  assert.equal(updated.runs.length,2);
  await restarted.close();
});

test("busy retries use the same nonce; a later occurrence does not create another pending job",async t=>{
  let attempt=0;
  const f=fixture(t,{dispatch:async()=>{if(++attempt===1)throw Object.assign(new Error("busy"),{safeToRetry:true});return {messageId:"accepted"};}});
  const routine=await create(f,{enabled:true});
  f.setTime(routine.nextRunAt);await f.api.tick();
  assert.equal((await f.api.list("owner","room"))[0].lastReason,"room_busy");
  await f.api.tick();assert.equal(f.calls.length,1);
  f.advance(300000);await f.api.tick();
  assert.equal(f.calls.length,2);
  assert.equal(f.calls[0].occurrenceId,f.calls[1].occurrenceId);
  const statuses=f.db.prepare("SELECT status,reason FROM routine_runs ORDER BY rowid").all();
  assert.deepEqual(statuses.map(row=>[row.status,row.reason]),[["submitted",""],["skipped","previous_run_pending"]]);
});

test("an orphaned claim from an interrupted prior tick is not left running or replayed",async t=>{
  const f=fixture(t),routine=await create(f,{enabled:true});
  f.setTime(routine.nextRunAt);await f.api.tick();
  // Preserve this same instance's lease token, simulating a failed final DB write.
  f.db.prepare("UPDATE routine_runs SET status='running',finished_at=NULL").run();
  await f.api.tick();
  assert.equal(f.calls.length,1);
  assert.equal(f.db.prepare("SELECT status FROM routine_runs").get().status,"interrupted");
});

test("manual execution works while paused and retries the same request id without repeating a message",async t=>{
  const hold=Promise.withResolvers(),f=fixture(t,{dispatch:()=>hold.promise}),routine=await create(f,{model:"fixture/model",effort:"high"});
  const first=await f.api.runNow("owner",routine.id,{requestId:"manual-1"});
  const repeated=await f.api.runNow("owner",routine.id,{requestId:"manual-1"});
  assert.equal(first.run.id,repeated.run.id);
  await assert.rejects(f.api.runNow("owner",routine.id,{requestId:"manual-2"}),{status:409});
  await settle();assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].routine.model,"fixture/model");assert.equal(f.calls[0].routine.effort,"high");
  hold.resolve({messageId:"manual-message"});await f.api.tick();
  await f.api.runNow("owner",routine.id,{requestId:"manual-1"});await f.api.tick();
  assert.equal(f.calls.length,1);
  await f.api.remove("owner",routine.id);
  assert.equal((await f.api.list("owner","room")).length,0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM routine_runs").get().n,1);
  await assert.rejects(f.api.runNow("owner",routine.id),{status:404});
});

test("revoked membership prevents dispatch and disables future runs without exposing callback errors",async t=>{
  const f=fixture(t),routine=await create(f,{enabled:true});
  f.setTime(routine.nextRunAt);f.allow(false);await f.api.tick();
  assert.equal(f.calls.length,0);
  assert.equal(f.db.prepare("SELECT enabled,next_run_at FROM routines").get().enabled,0);
  assert.equal(f.db.prepare("SELECT reason FROM routine_runs").get().reason,"access_revoked");
  await assert.rejects(f.api.list("owner","room"),{status:403});
  f.allow(true);
  assert.equal((await f.api.list("owner","room"))[0].nextRunAt,null);
});

test("unknown dispatch failures never retry and raw errors are not persisted or returned",async t=>{
  const f=fixture(t,{dispatch:async()=>{throw new Error("secret.example private prompt or API key");}}),routine=await create(f,{enabled:true});
  f.setTime(routine.nextRunAt);await f.api.tick();await f.api.tick();
  const result=(await f.api.list("owner","room"))[0];
  assert.equal(result.lastStatus,"failed");assert.equal(result.lastReason,"dispatch_failed");
  assert.equal(f.calls.length,1);
  assert.doesNotMatch(JSON.stringify(result),/secret\.example/);
  assert.doesNotMatch(JSON.stringify(f.db.prepare("SELECT * FROM routine_runs").all()),/secret\.example/);
});

test("pause cancels queued busy work and re-enable schedules only a future occurrence",async t=>{
  const f=fixture(t,{dispatch:async()=>{throw Object.assign(new Error("busy"),{safeToRetry:true});}}),routine=await create(f,{enabled:true});
  f.setTime(routine.nextRunAt);await f.api.tick();
  const paused=await f.api.update("owner",routine.id,{enabled:false});
  assert.equal(paused.lastStatus,"skipped");assert.equal(paused.lastReason,"routine_paused");
  f.advance(600000);await f.api.tick();assert.equal(f.calls.length,1);
  const enabled=await f.api.update("owner",routine.id,{enabled:true});
  assert.equal(enabled.nextRunAt,routine.nextRunAt+900000);
});

test("close aborts an in-flight dispatch and records uncertainty instead of retrying it",async t=>{
  const f=fixture(t,{dispatch:()=>new Promise(()=>{})}),routine=await create(f,{enabled:true});
  f.setTime(routine.nextRunAt);const pending=f.api.tick();await settle();
  await f.api.close();await pending;
  assert.equal(f.calls[0].signal.aborted,true);
  assert.equal(f.db.prepare("SELECT status FROM routine_runs").get().status,"interrupted");
  const restarted=f.make();await restarted.tick();assert.equal(f.calls.length,1);await restarted.close();
});
