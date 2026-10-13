import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

async function fixture(t,complete) {
 const dir=await mkdtemp(join(tmpdir(),'routine-http-')),calls=[];
 const app=await startCommunity({dataDir:dir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap'},llm:{name:'test',complete:async req=>{calls.push(req);return complete?complete(req):'SendMessage: '+JSON.stringify({type:'text',content:req.isolation?.botId==='title'?'가지의 새 주제':'맥락을 이어 답했습니다.'});}}});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 function client(){let cookie='',csrf='';const call=async(path,body,method=body===undefined?'GET':'POST',useCsrf=true)=>{const r=await fetch(app.url+path,{method,headers:{cookie,'content-type':'application/json',...(useCsrf?{'x-csrf-token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});const v=await r.json();if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];if(v.csrfToken)csrf=v.csrfToken;return {status:r.status,...v};};return call;}
 const owner=client();const session=await owner('/api/register',{username:'owner',displayName:'루틴 주인',password:'routine-test-password',inviteToken:'bootstrap'});assert.equal(session.status,201);
 const room=(await owner('/api/rooms',{name:'기존 대화'})).room;
 const routine=async(extra={})=>{const result=await owner(`/api/rooms/${room.id}/routines`,{title:'아침 정리',prompt:'전에 정한 계획을 이어서 정리해줘',enabled:false,schedule:{type:'daily',time:'09:00',timezone:'Asia/Seoul'},...extra});assert.equal(result.status,201,JSON.stringify(result));return result.routine;};
 return {app,calls,owner,room,routine,client,user:session.user};
}

test('routines use the same room, human identity, previous context and nonce-deduplicated message pipeline',async t=>{
 const f=await fixture(t);
 await f.owner(`/api/rooms/${f.room.id}/messages`,{text:'이전 결정: 다음 주 화요일 출시.',clientNonce:'prior',botIds:[]});
 const routine=await f.routine();const before=f.app.db.prepare('SELECT count(*) n FROM rooms').get().n;
 const run=await f.owner(`/api/routines/${routine.id}/run`,{requestId:'manual-once'});assert.equal(run.status,202);await f.app.routines.tick();
 const messages=f.app.db.prepare('SELECT * FROM messages WHERE room_id=? AND kind=\'human\'').all(f.room.id);
 assert.equal(messages.length,2);assert.equal(messages[1].author_id,f.user.id);assert.equal(messages[1].author,'루틴 주인');assert.equal(messages[1].text,routine.prompt);
 assert.equal(f.app.db.prepare('SELECT count(*) n FROM rooms').get().n,before);
 const again=await f.owner(`/api/routines/${routine.id}/run`,{requestId:'manual-once'});assert.equal(again.status,202);await f.app.routines.tick();
 assert.equal(f.app.db.prepare("SELECT count(*) n FROM messages WHERE room_id=? AND kind='human'").get(f.room.id).n,2);
 for(let i=0;i<100&&!f.calls.some(r=>r.isolation?.botId==='bot-analyst');i++)await new Promise(r=>setTimeout(r,10));
 const request=f.calls.find(r=>r.isolation?.botId==='bot-analyst');assert.match(request.user,/다음 주 화요일 출시/);assert.match(request.user,/전에 정한 계획/);assert.equal(request.isolation.roomId,f.room.id);
 const listing=await f.owner(`/api/rooms/${f.room.id}/routines`);assert.equal(listing.routines[0].lastStatus,'submitted');assert.ok(listing.routines[0].runs[0].messageId);
 for(let i=0;i<100&&!f.app.db.prepare("SELECT 1 FROM messages WHERE room_id=? AND kind='bot'").get(f.room.id);i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(f.app.db.prepare("SELECT text FROM messages WHERE room_id=? AND kind='bot'").get(f.room.id)?.text,'맥락을 이어 답했습니다.');
});

test('routine ownership, room access and CSRF are checked for invited users too',async t=>{
 const f=await fixture(t),other=f.client(),invite=await f.owner('/api/admin/invites',{});
 assert.equal((await other('/api/register',{username:'other',displayName:'다른 사용자',password:'routine-test-password',inviteToken:invite.token})).status,201);
 const r=await f.routine();
 assert.equal((await other(`/api/rooms/${f.room.id}/routines`)).status,404);
 const link=await f.owner(`/api/rooms/${f.room.id}/invites`,{});await other('/api/rooms/join',{token:link.token});
 assert.deepEqual((await other(`/api/rooms/${f.room.id}/routines`)).routines,[]);
 assert.equal((await other(`/api/routines/${r.id}/run`,{})).status,404);
 assert.equal((await other(`/api/routines/${r.id}`,{enabled:true},'PATCH')).status,404);
 assert.equal((await other(`/api/routines/${r.id}`,undefined,'DELETE')).status,404);
 assert.equal((await f.owner(`/api/routines/${r.id}`,{enabled:true},'PATCH',false)).status,403);
 assert.equal((await f.owner(`/api/routines/${r.id}`,{model:'invalid model'},'PATCH')).status,400);
 assert.equal((await other(`/api/rooms/${f.room.id}/routines`,{prompt:'나의 루틴',schedule:{type:'daily',time:'12:00'}})).status,201);
 assert.equal((await f.owner(`/api/routines/${r.id}`,{enabled:true},'PATCH')).status,200);
 assert.equal((await f.owner(`/api/routines/${r.id}`,undefined,'DELETE')).status,200);
 assert.deepEqual((await f.owner(`/api/rooms/${f.room.id}/routines`)).routines,[]);
});

test('a scheduled routine stops if its owner archives the room',async t=>{
 const f=await fixture(t),r=await f.routine({enabled:true});
 f.app.db.prepare('UPDATE routines SET next_run_at=? WHERE id=?').run(Date.now(),r.id);
 assert.equal((await f.owner(`/api/rooms/${f.room.id}/preferences`,{archived:true,pinned:false})).status,200);
 await f.app.routines.tick();
 assert.equal(f.app.db.prepare('SELECT enabled FROM routines WHERE id=?').get(r.id).enabled,0);
 assert.equal(f.app.db.prepare('SELECT reason FROM routine_runs WHERE routine_id=?').get(r.id).reason,'access_revoked');
 assert.equal(f.app.db.prepare('SELECT count(*) n FROM messages WHERE room_id=?').get(f.room.id).n,0);
});

test('fork titles are based only on the first new message and not copied history or subsequent sends',async t=>{
 const f=await fixture(t);
 await f.owner(`/api/rooms/${f.room.id}/messages`,{text:'원래 대화의 이야기',clientNonce:'original',botIds:[]});
 const child=(await f.owner(`/api/rooms/${f.room.id}/fork`,{})).room;assert.equal(child.pendingTitle,true);
 const send=()=>f.owner(`/api/rooms/${child.id}/messages`,{text:'이번에는 여행 일정 정리',clientNonce:'branch-first',botIds:[]});
 assert.equal((await send()).status,202);await send();
 await f.owner(`/api/rooms/${child.id}/messages`,{text:'다음 메시지는 제목을 바꾸지 않아',clientNonce:'branch-next',botIds:[]});
 const fresh=await f.owner(`/api/rooms/${child.id}`);assert.equal(fresh.room.pendingTitle,false);assert.equal(fresh.room.name,'가지의 새 주제');
 const titleCalls=f.calls.filter(r=>r.isolation?.botId==='title');assert.equal(titleCalls.length,1);assert.equal(titleCalls[0].user,'이번에는 여행 일정 정리');
 assert.equal((await f.owner(`/api/rooms/${f.room.id}`)).room.name,'기존 대화');
 assert.equal(fresh.messages.filter(m=>m.text==='이번에는 여행 일정 정리').length,1);
});


test('existing unstarted forks gain titles without renaming branches already used',async t=>{
 const f=await fixture(t);
 await f.owner(`/api/rooms/${f.room.id}/messages`,{text:'복사할 기존 맥락',clientNonce:'source',botIds:[]});
 const child=(await f.owner(`/api/rooms/${f.room.id}/fork`,{})).room;
 f.app.db.prepare('DELETE FROM settings WHERE key=?').run('pending-title:'+child.id);
 assert.equal((await f.owner(`/api/rooms/${child.id}`)).room.pendingTitle,true);
 await f.owner(`/api/rooms/${child.id}/messages`,{text:'이미 만든 가지의 첫 새 질문',clientNonce:'first-own',botIds:[]});
 assert.equal((await f.owner(`/api/rooms/${child.id}`)).room.name,'가지의 새 주제');
 f.app.db.prepare('UPDATE rooms SET name=? WHERE id=?').run('사용 중인 가지 · Fork',child.id);
 assert.equal((await f.owner(`/api/rooms/${child.id}`)).room.pendingTitle,false);
 await f.owner(`/api/rooms/${child.id}/messages`,{text:'계속 이어가기',clientNonce:'next-own',botIds:[]});
 assert.equal((await f.owner(`/api/rooms/${child.id}`)).room.name,'사용 중인 가지 · Fork');
});
