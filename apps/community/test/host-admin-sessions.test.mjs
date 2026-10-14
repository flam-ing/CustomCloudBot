import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startCommunity} from '../server.mjs';

const normalized = content => 'SendMessage: '+JSON.stringify({type:'text',content});
const toolNames = request => (request.toolDefinitions ?? []).map(tool=>tool.function.name);

async function until(check) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    if(await check())return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('The local test turn did not finish in time');
}

async function fixture(t,{beforeTool,forceUnadvertised=false}={}) {
  // Keep the Unix path below macOS's socket path limit; this broker never executes a command.
  const dir=await mkdtemp('/tmp/host-session-'),socket=join(dir,'control.sock');
  const calls=[],titleCalls=[],hostRequests=[];
  let app;
  const broker=createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    hostRequests.push({path:req.url,method:req.method,...body});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({scope:'host-root',requestId:body.requestId,stdout:'0\n',stderr:'',exitCode:0}));
  });
  t.after(async()=>{
    await app?.close();
    broker.closeAllConnections();
    if(broker.listening)await new Promise(resolve=>broker.close(resolve));
    await rm(dir,{recursive:true,force:true});
  });
  await new Promise((resolve,reject)=>{broker.once('error',reject);broker.listen(socket,resolve);});
  const llm={name:'host-session-test',complete:async request=>{
    if(request.isolation?.botId==='title') {
      titleCalls.push(request);
      return normalized('관리자 작업 확인');
    }
    const call={request,tools:toolNames(request)};
    calls.push(call);
    if(call.tools.includes('host_exec') || forceUnadvertised) {
      await beforeTool?.({app,request});
      try {
        call.result=JSON.parse(await request.browser('host_exec',{command:'id -u'}));
      } catch(error) {
        call.error={status:error.status,message:error.message};
      }
    }
    call.finished=true;
    return normalized(call.result?'서버 작업 확인 완료':'현재 계정 권한 확인 완료');
  }};
  const browserTools={configured:()=>true,execute:async()=>{throw new Error('Unexpected browser dispatch');},close:async()=>{}};
  const start=env=>startCommunity({dataDir:join(dir,'data'),port:0,env,llm,browserTools});
  app=await start({COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap'});
  function client() {
    let cookie='',csrf='';
    return async(path,body,method=body===undefined?'GET':'POST')=>{
      const response=await fetch(app.url+path,{method,headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
      const value=await response.json();
      if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
      if(value.csrfToken)csrf=value.csrfToken;
      return {status:response.status,...value};
    };
  }
  const owner=client(),member=client();
  const registered=await owner('/api/register',{username:'owner',displayName:'운영자',password:'host-session-test-password',inviteToken:'bootstrap'});
  assert.equal(registered.status,201);
  assert.equal(registered.user.hostAdmin,false);
  const invite=await owner('/api/admin/invites',{});
  const invited=await member('/api/register',{username:'member',displayName:'초대 사용자',password:'host-session-test-password',inviteToken:invite.token});
  assert.equal(invited.status,201);
  await app.close();
  app=await start({COMMUNITY_HOST_ADMIN_SOCKET:socket,COMMUNITY_HOST_ADMIN_USER_IDS:registered.user.id});
  assert.equal((await owner('/api/session')).user.hostAdmin,true);
  assert.equal((await member('/api/session')).user.hostAdmin,false);

  async function room(actor,name) {
    const result=await actor('/api/rooms',{name});
    assert.equal(result.status,201,JSON.stringify(result));
    return result.room;
  }
  async function share(actor,other,source) {
    const invite=await actor(`/api/rooms/${source.id}/invites`,{});
    assert.equal(invite.status,201,JSON.stringify(invite));
    assert.equal((await other('/api/rooms/join',{token:invite.token})).status,200);
  }
  async function fork(actor,source) {
    const result=await actor(`/api/rooms/${source.id}/fork`,{});
    assert.equal(result.status,201,JSON.stringify(result));
    return result.room;
  }
  async function waitTurn(actor,source,before) {
    await until(async()=>calls.length>before && calls.slice(before).every(call=>call.finished) && !(await actor(`/api/rooms/${source.id}`)).busy);
    const added=calls.slice(before);
    assert.equal(added.length,1,'one bot request, excluding the independent fork title request');
    return added[0];
  }
  async function send(actor,source,prompt='이 요청의 서버 권한을 확인해줘') {
    const before=calls.length;
    const result=await actor(`/api/rooms/${source.id}/messages`,{text:prompt,clientNonce:randomUUID(),botIds:['bot-analyst']});
    assert.equal(result.status,202,JSON.stringify(result));
    return waitTurn(actor,source,before);
  }
  async function routine(actor,source) {
    const created=await actor(`/api/rooms/${source.id}/routines`,{title:'서버 확인',prompt:'이 계정으로 서버 상태를 확인해줘',enabled:false,schedule:{type:'daily',time:'09:00',timezone:'Asia/Seoul'}});
    assert.equal(created.status,201,JSON.stringify(created));
    const before=calls.length;
    assert.equal((await actor(`/api/routines/${created.routine.id}/run`,{requestId:randomUUID()})).status,202);
    await app.routines.tick();
    const call=await waitTurn(actor,source,before);
    const listing=await actor(`/api/rooms/${source.id}/routines`);
    assert.equal(listing.routines.find(item=>item.id===created.routine.id).lastStatus,'submitted');
    return call;
  }
  return {app,owner,member,ownerId:registered.user.id,memberId:invited.user.id,calls,titleCalls,hostRequests,room,share,fork,send,routine};
}

function allowed(call,userId,roomId) {
  assert.ok(call.tools.includes('host_exec'));
  assert.equal(call.error,undefined);
  assert.equal(call.result.scope,'host-root');
  assert.equal(call.result.stdout,'0\n');
  assert.equal(call.request.isolation.userId,userId);
  assert.equal(call.request.isolation.roomId,roomId);
  assert.match(call.request.system,/서버 전체의 관리자 도구\(host_exec\)/);
}

function notAdvertised(call,userId) {
  assert.ok(!call.tools.includes('host_exec'));
  assert.equal(call.result,undefined);
  assert.equal(call.request.isolation.userId,userId);
  assert.doesNotMatch(call.request.system,/서버 전체의 관리자 도구\(host_exec\)/);
}

test('owner authority follows the current sender across normal rooms, forks and both directions of room sharing',async t=>{
  const f=await fixture(t);
  const ownerRoom=await f.room(f.owner,'소유자 대화');
  allowed(await f.send(f.owner,ownerRoom),f.ownerId,ownerRoom.id);
  const ownerFork=await f.fork(f.owner,ownerRoom);
  allowed(await f.send(f.owner,ownerFork),f.ownerId,ownerFork.id);
  const memberRoom=await f.room(f.member,'초대 사용자 대화');
  await f.share(f.member,f.owner,memberRoom);
  allowed(await f.send(f.owner,memberRoom),f.ownerId,memberRoom.id);
  await f.share(f.owner,f.member,ownerRoom);
  notAdvertised(await f.send(f.member,ownerRoom),f.memberId);
  const memberFork=await f.fork(f.member,ownerRoom);
  notAdvertised(await f.send(f.member,memberFork),f.memberId);
  assert.equal(f.hostRequests.length,3,'room ownership or copied owner messages do not elevate an invited sender');
  assert.deepEqual(f.hostRequests.map(request=>[request.userId,request.roomId]),[[f.ownerId,ownerRoom.id],[f.ownerId,ownerFork.id],[f.ownerId,memberRoom.id]]);
  for(const request of f.hostRequests) {
    assert.equal(request.command,'id -u');
    assert.equal(request.path,'/execute');
    assert.equal(request.method,'POST');
  }
  assert.equal(f.titleCalls.length,2);
  for(const request of f.titleCalls)assert.ok(!toolNames(request).includes('host_exec'),'title generation receives no privileged tools');
});

test('routines use their initiating account authority, including in a room owned by another account',async t=>{
  const f=await fixture(t);
  const shared=await f.room(f.member,'루틴 공동 대화');
  await f.share(f.member,f.owner,shared);
  allowed(await f.routine(f.owner,shared),f.ownerId,shared.id);
  notAdvertised(await f.routine(f.member,shared),f.memberId);
  assert.equal(f.hostRequests.length,1);
  assert.equal(f.hostRequests[0].userId,f.ownerId);
  const authors=f.app.db.prepare("SELECT author_id FROM messages WHERE room_id=? AND kind='human' ORDER BY rowid").all(shared.id);
  assert.deepEqual(authors.map(row=>row.author_id),[f.ownerId,f.memberId]);
});

test('an unadvertised host tool cannot be invoked through an invited user browser callback',async t=>{
  const f=await fixture(t,{forceUnadvertised:true});
  const shared=await f.room(f.owner,'소유자 공동 대화');
  await f.share(f.owner,f.member,shared);
  const call=await f.send(f.member,shared);
  notAdvertised(call,f.memberId);
  assert.equal(call.error?.status,403);
  assert.equal(f.hostRequests.length,0);
});

test('only the first selected bot in an owner turn can execute host commands',async t=>{
  const f=await fixture(t,{forceUnadvertised:true});
  const source=await f.room(f.owner,'여러 역할의 서버 작업');
  const accepted=await f.owner(`/api/rooms/${source.id}/messages`,{
    text:'서버 작업을 실행하고 다른 역할은 결과를 검토해줘',clientNonce:randomUUID(),
    botIds:['bot-analyst','bot-creative','bot-reviewer'],
  });
  assert.equal(accepted.status,202,JSON.stringify(accepted));
  await until(async()=>f.calls.length===3 && f.calls.every(call=>call.finished) && !(await f.owner(`/api/rooms/${source.id}`)).busy);
  allowed(f.calls[0],f.ownerId,source.id);
  for(const call of f.calls.slice(1)) {
    assert.ok(!call.tools.includes('host_exec'),'later roles review the first result without advertising root execution');
    assert.equal(call.result,undefined);
    assert.equal(call.error?.status,403,'forcing the unadvertised tool is denied in the callback too');
    assert.match(call.request.user,/서버 작업 확인 완료/,'reviewers receive the first bot result');
  }
  assert.equal(f.hostRequests.length,1,'one user turn cannot repeat a mutation through the selected bot roles');
  assert.equal(f.hostRequests[0].userId,f.ownerId);
  assert.equal(f.hostRequests[0].roomId,source.id);
});

test('revoking the owner role after tool advertisement blocks dispatch and subsequent session capabilities',async t=>{
  const f=await fixture(t,{beforeTool:({app,request})=>{
    app.db.prepare("UPDATE users SET role='member' WHERE id=?").run(request.isolation.userId);
  }});
  const source=await f.room(f.owner,'권한 변경 확인');
  const call=await f.send(f.owner,source);
  assert.ok(call.tools.includes('host_exec'),'the role was valid when tools were advertised');
  assert.equal(call.error?.status,403);
  assert.equal(call.result,undefined);
  assert.equal(f.hostRequests.length,0,'the broker receives no command after revocation');
  assert.equal((await f.owner('/api/session')).user.hostAdmin,false);
  notAdvertised(await f.send(f.owner,source),f.ownerId);
  assert.equal(f.hostRequests.length,0);
});
