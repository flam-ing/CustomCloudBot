import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};};
const answer = text => ({choices:[{message:{role:'assistant',content:text}}],usage:{prompt_tokens:12,completion_tokens:3}});
const models = ['chat-1','chat-2','chat-3','chat-4'];
async function until(read, description) {
  const deadline = Date.now()+5000;
  while(Date.now()<deadline) {
    const result=await read();if(result)return result;
    await pause(10);
  }
  assert.fail('Timed out: '+description);
}

async function fixture(t,{respond,waitMs=4000}={}) {
  const dir=await mkdtemp(join(tmpdir(),'community-model-control-'));
  const requests=[],chats=[];
  const provider=createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
      requests.push({method:req.method,path:req.url,body});
      if(req.method==='GET'&&req.url==='/v1/models') {
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:models.map(id=>({id}))}));return;
      }
      if(req.method==='POST'&&req.url==='/v1/chat/completions') {
        const call={body,index:chats.length};chats.push(call);
        const reply=await respond?.(call)??{body:answer('RECOVERED_REPLY')};
        if(res.destroyed)return;
        res.writeHead(reply.status??200,{'content-type':'application/json'});res.end(JSON.stringify(reply.body??answer('')));return;
      }
      res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error:'unexpected fixture route'}));
    } catch {
      if(!res.destroyed){res.writeHead(500,{'content-type':'application/json'});res.end('{}');}
    }
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  let app;
  t.after(async()=>{
    await app?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(dir,{recursive:true,force:true});
  });
  app=await startCommunity({dataDir:dir,port:0,modelControlWaitMs:waitMs,env:{
    COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap',
    COMMUNITY_LLM_PROVIDERS:JSON.stringify([{name:'fixture',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'test-provider-secret',model:'chat-1'}]),
  }});
  async function call(path,{auth,body,method=body===undefined?'GET':'POST',csrf=true}={}) {
    const response=await fetch(app.url+path,{method,headers:{'content-type':'application/json',
      ...(auth?{cookie:auth.cookie,...(csrf?{'x-csrf-token':auth.csrf}:{})}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
    return {status:response.status,data:await response.json(),response};
  }
  async function register(username,owner) {
    const inviteToken=owner?(await call('/api/admin/invites',{auth:owner,body:{}})).data.token:'bootstrap';
    const result=await call('/api/register',{body:{username,displayName:username,password:'model-control-test-password',inviteToken}});
    assert.equal(result.status,201);
    return {id:result.data.user.id,cookie:result.response.headers.get('set-cookie').split(';')[0],csrf:result.data.csrfToken};
  }
  async function room(auth) {
    const result=await call('/api/rooms',{auth,body:{name:'모델 전환 검사'}});assert.equal(result.status,201);return result.data.room.id;
  }
  async function joinRoom(owner,member,id) {
    const token=(await call(`/api/rooms/${id}/invites`,{auth:owner,body:{}})).data.token;
    assert.equal((await call('/api/rooms/join',{auth:member,body:{token}})).status,200);
  }
  const detail=async(auth,id)=>(await call(`/api/rooms/${id}`,{auth})).data;
  const waitFor=(auth,id,phase)=>until(async()=>{const value=await detail(auth,id);return value.modelControl?.phase===phase&&value;},phase);
  const idle=(auth,id)=>until(async()=>{const value=await detail(auth,id);return !value.busy&&value;},'idle room');
  const send=(auth,id,text,extra={})=>call(`/api/rooms/${id}/messages`,{auth,body:{text,clientNonce:randomUUID(),botIds:['bot-analyst'],...extra}});
  async function progress(auth,id) {
    const controller=new AbortController(),events=[];
    const response=await fetch(app.url+`/api/rooms/${id}/progress`,{headers:{cookie:auth.cookie},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])});
    assert.equal(response.status,200);t.after(()=>controller.abort());
    const done=(async()=>{
      let buffer='';const decoder=new TextDecoder();
      for await(const chunk of response.body) {
        buffer+=decoder.decode(chunk,{stream:true});
        let end;
        while((end=buffer.indexOf('\n\n'))!==-1) {
          const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
          const event=block.match(/^event: (.+)$/m)?.[1],data=block.match(/^data: (.+)$/m)?.[1];
          if(event&&data)events.push({event,data:JSON.parse(data)});
        }
      }
      return events;
    })();
    // Attach a handler immediately so cleanup aborts cannot become an unhandled rejection.
    void done.catch(()=>{});
    return {events,done,close:()=>controller.abort()};
  }
  return {app,requests,chats,call,register,room,joinRoom,detail,waitFor,idle,send,progress};
}

function assertOnePrompt(data,text) {
  assert.deepEqual(data.messages.filter(item=>item.kind==='human').map(item=>item.text),[text]);
}
const failsFirstThree=call=>({body:answer(call.body.model==='chat-4'?'RECOVERED_REPLY':'')});

test('automatic fallback publishes safe live transitions and completes without another human message',async t=>{
  const first=deferred();
  const f=await fixture(t,{respond:async call=>{if(call.index===0){await first.promise;return {body:answer('')};}return {body:answer('AUTOMATIC_RECOVERY')};}});
  const owner=await f.register('auto_owner'),id=await f.room(owner);
  const sent=await f.send(owner,id,'ORIGINAL_AUTO_REQUEST');assert.equal(sent.status,202);
  await until(()=>f.chats[0],'first provider call');
  const stream=await f.progress(owner,id);
  const initial=await f.detail(owner,id);
  assert.equal(initial.modelControl.visible,false);
  assert.equal((await f.call(`/api/rooms/${id}/model-control`,{auth:owner,body:{runId:initial.modelControl.runId,action:'stop'}})).status,409,'ordinary in-flight replies do not expose retry controls');
  first.resolve();const events=await stream.done,done=await f.idle(owner,id);
  assert.deepEqual(f.chats.map(item=>item.body.model),['chat-1','chat-2']);
  assert.deepEqual(f.chats[1].body.messages,f.chats[0].body.messages);
  const states=events.filter(item=>item.event==='model-control').map(item=>item.data);
  assert.ok(states.some(item=>item.phase==='switching'&&item.visible));
  assert.ok(states.some(item=>item.phase==='trying'&&item.model==='chat-2'&&item.visible&&item.canControl));
  assert.ok(states.some(item=>item.phase==='complete'&&!item.visible&&!item.canControl));
  assert.ok(events.some(item=>item.event==='done'));
  assertOnePrompt(done,'ORIGINAL_AUTO_REQUEST');
  assert.deepEqual(done.messages.filter(item=>item.kind==='bot').map(item=>item.text),['AUTOMATIC_RECOVERY']);
  assert.equal(done.modelControl.visible,false);
  assert.doesNotMatch(JSON.stringify({events,done}),/test-provider-secret|apiKey|baseUrl/);
  assert.ok(f.requests.some(item=>item.method==='GET'&&item.path==='/v1/models'));
});

test('waiting exhaustion can continue the same prompt through manual selection or automatic retry',async t=>{
  for(const action of ['select','auto']) await t.test(action,async t=>{
    const f=await fixture(t,{respond:failsFirstThree}),owner=await f.register('recovery_'+action),id=await f.room(owner);
    assert.equal((await f.send(owner,id,'PRESERVE_'+action)).status,202);
    const waiting=await f.waitFor(owner,id,'waiting'),runId=waiting.modelControl.runId;
    assert.equal(waiting.busy,true);assert.equal(waiting.modelControl.visible,true);assert.equal(waiting.modelControl.canControl,true);
    assert.deepEqual(f.chats.map(item=>item.body.model),['chat-1','chat-2','chat-3']);
    assertOnePrompt(waiting,'PRESERVE_'+action);
    const stream=await f.progress(owner,id);
    const changed=await f.call(`/api/rooms/${id}/model-control`,{auth:owner,body:{runId,action,...(action==='select'?{model:'chat-4'}:{})}});
    assert.equal(changed.status,200);assert.equal(changed.data.status.runId,runId);assert.equal(changed.data.status.automatic,action==='auto');
    const events=await stream.done,done=await f.idle(owner,id);
    assert.deepEqual(f.chats.map(item=>item.body.model),['chat-1','chat-2','chat-3','chat-4']);
    for(const chat of f.chats.slice(1))assert.deepEqual(chat.body.messages,f.chats[0].body.messages);
    assert.ok(events.some(item=>item.event==='model-control'&&item.data.phase==='trying'&&item.data.model==='chat-4'&&item.data.automatic===(action==='auto')));
    assertOnePrompt(done,'PRESERVE_'+action);assert.equal(done.modelControl.runId,runId);assert.equal(done.modelControl.phase,'complete');
    assert.deepEqual(done.messages.filter(item=>item.kind==='bot').map(item=>item.text),['RECOVERED_REPLY']);
    assert.equal((await f.call(`/api/rooms/${id}/model-control`,{auth:owner,body:{runId,action:'auto'}})).status,409);
  });
});

test('only the original requester controls a shared run; stop preserves the prompt and stale controls return 409',async t=>{
  const f=await fixture(t,{respond:failsFirstThree});
  const owner=await f.register('control_owner'),member=await f.register('control_member',owner),outsider=await f.register('control_outsider',owner),id=await f.room(owner);
  await f.joinRoom(owner,member,id);
  assert.equal((await f.send(member,id,'MEMBER_ORIGINAL_REQUEST')).status,202);
  const waiting=await f.waitFor(member,id,'waiting'),runId=waiting.modelControl.runId,path=`/api/rooms/${id}/model-control`;
  assert.equal(waiting.modelControl.userId,member.id);assert.equal(waiting.modelControl.canControl,true);
  assert.equal((await f.detail(owner,id)).modelControl.canControl,false,'site admin and room owner cannot control another actor’s request');
  const body={runId,action:'stop'};
  assert.equal((await f.call(path,{body})).status,401);
  assert.equal((await f.call(path,{auth:member,body,csrf:false})).status,403);
  assert.equal((await f.call(path,{auth:outsider,body})).status,404);
  assert.equal((await f.call(path,{auth:owner,body})).status,403);
  assert.equal((await f.call(path,{auth:member,body:{...body,runId:randomUUID()}})).status,409);
  assert.equal((await f.call(path,{auth:member,body:{runId,action:'unknown'}})).status,400);
  assert.equal((await f.call(path,{auth:member,body:{runId,action:'select',model:'invalid model'}})).status,400);
  assert.equal((await f.detail(member,id)).modelControl.phase,'waiting');
  assert.equal(f.chats.length,3,'unauthorized or stale controls cannot resume work');
  const stream=await f.progress(member,id);
  const stopped=await f.call(path,{auth:member,body});assert.equal(stopped.status,200);
  assert.equal(stopped.data.status.phase,'stopped');assert.equal(stopped.data.status.canControl,false);
  const events=await stream.done,done=await f.idle(member,id);
  assert.ok(events.some(item=>item.event==='model-control'&&item.data.phase==='stopped'));
  assertOnePrompt(done,'MEMBER_ORIGINAL_REQUEST');assert.equal(done.modelControl.phase,'stopped');assert.equal(f.chats.length,3);
  assert.equal((await f.call(path,{auth:member,body})).status,409);
});

test('an unanswered exhausted run finishes within the configured short wait and rejects later controls',async t=>{
  const f=await fixture(t,{respond:failsFirstThree,waitMs:80}),owner=await f.register('wait_owner'),id=await f.room(owner);
  assert.equal((await f.send(owner,id,'EXHAUSTED_REQUEST')).status,202);
  const done=await f.idle(owner,id);
  assert.equal(done.modelControl.phase,'exhausted');assert.equal(done.modelControl.visible,true);assert.equal(done.modelControl.canControl,false);
  assertOnePrompt(done,'EXHAUSTED_REQUEST');assert.equal(f.chats.length,3);
  assert.equal((await f.call(`/api/rooms/${id}/model-control`,{auth:owner,body:{runId:done.modelControl.runId,action:'select',model:'chat-4'}})).status,409);
  assert.doesNotMatch(JSON.stringify(done),/test-provider-secret|apiKey|baseUrl/);
});
