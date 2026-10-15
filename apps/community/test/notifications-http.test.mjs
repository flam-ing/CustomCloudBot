import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'notifications-http-')),sent=[];
  let time=Date.now();
  const mailbox={configured:true,list:async()=>({messages:[],cursor:null}),send:async input=>{sent.push(input);return {accepted:true};}};
  const app=await startCommunity({dataDir:dir,port:0,mailbox,notificationNow:()=>time,env:{COMMUNITY_BOOTSTRAP_TOKEN:'notifications-test'}});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  async function call(path,auth,body,csrf=true) {
    const response=await fetch(app.url+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(auth?{cookie:auth.cookie,...(csrf?{'x-csrf-token':auth.csrf}:{})}:{})},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    return {status:response.status,data:await response.json(),response};
  }
  async function register(username,admin) {
    const inviteToken=admin?(await call('/api/admin/invites',admin,{})).data.token:'notifications-test';
    const result=await call('/api/register',null,{username,displayName:username,password:'notifications-password',inviteToken});
    assert.equal(result.status,201);
    return {id:result.data.user.id,csrf:result.data.csrfToken,cookie:result.response.headers.get('set-cookie').split(';')[0]};
  }
  async function room(owner,member) {
    const roomId=(await call('/api/rooms',owner,{name:'Conversation'})).data.room.id;
    const invite=await call(`/api/rooms/${roomId}/invites`,owner,{});
    assert.equal((await call('/api/rooms/join',member,{token:invite.data.token})).status,200);
    return roomId;
  }
  return {app,sent,call,register,room,advance:n=>{time+=n;}};
}

test('notifications routes require auth and CSRF; preferences are per-user and cannot set arbitrary recipients',async t=>{
  const f=await fixture(t),owner=await f.register('notice_owner'),member=await f.register('notice_member',owner);
  for(const path of ['/api/notifications','/api/notifications/settings'])assert.equal((await f.call(path)).status,401);
  assert.deepEqual((await f.call('/api/notifications/settings',owner)).data,{soundEnabled:true,emailEnabled:false,emailAddress:'',emailConfigured:false});
  assert.equal((await f.call('/api/notifications/settings',owner,{soundEnabled:false},false)).status,403);
  assert.equal((await f.call('/api/notifications/read',owner,{all:true},false)).status,403);
  assert.equal((await f.call('/api/notifications/settings',owner,{emailEnabled:true})).status,409);
  assert.equal((await f.call('/api/notifications/settings',owner,{emailAddress:'injected@example.test'})).status,400);
  assert.equal((await f.call('/api/notifications/settings',owner,{soundEnabled:false})).data.soundEnabled,false);
  assert.equal((await f.call('/api/notifications/settings',member)).data.soundEnabled,true);
  f.app.db.prepare('UPDATE mail_agent_config SET senders=? WHERE id=1').run(JSON.stringify([{email:'owner@example.test',userId:owner.id}]));
  assert.equal((await f.call('/api/notifications/settings',owner,{emailEnabled:true})).status,200);
  assert.equal((await f.call('/api/notifications/settings',member)).data.emailAddress,'');
});

test('real message insertion produces private generic feed IDs, read cancels mail and stale membership hides notices',async t=>{
  const f=await fixture(t),owner=await f.register('notice_sender'),member=await f.register('notice_reader',owner);
  const roomId=await f.room(owner,member);
  f.app.db.prepare('UPDATE mail_agent_config SET senders=? WHERE id=1').run(JSON.stringify([{email:'member@example.test',userId:member.id}]));
  await f.call('/api/notifications/settings',member,{emailEnabled:true});
  const initial=(await f.call('/api/notifications',member)).data.cursor;
  const input={text:'PRIVATE_MESSAGE_BODY',clientNonce:randomUUID(),botIds:[]};
  const sent=await f.call(`/api/rooms/${roomId}/messages`,owner,input);
  assert.equal(sent.status,202);assert.equal((await f.call(`/api/rooms/${roomId}/messages`,owner,input)).data.messageId,sent.data.messageId);
  const feed=await f.call(`/api/notifications?after=${initial}`,member);
  assert.equal(feed.status,200);assert.equal(feed.data.items.length,1);
  assert.equal(feed.data.items[0].id,`message:${roomId}:${sent.data.messageId}`);
  assert.ok(!JSON.stringify(feed.data).includes(input.text));
  assert.ok(!(await f.call('/api/notifications',owner)).data.items.some(item=>item.id.endsWith(sent.data.messageId)));
  assert.equal((await f.call('/api/notifications/read',member,{roomId})).data.read,1);
  f.advance(61_000);await f.app.notifications.poll();assert.equal(f.sent.length,0);
  const response=await f.call(`/api/rooms/${roomId}/messages`,owner,{text:'model',clientNonce:randomUUID(),botIds:[]});
  assert.equal(response.status,202);
  const next=(await f.call(`/api/notifications?after=${feed.data.cursor}`,member)).data;
  assert.deepEqual(next.items.map(item=>item.kind),['human','bot']);
  f.app.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('private-fork:'+roomId,'1');
  assert.equal((await f.call('/api/notifications',member)).data.items.filter(item=>item.roomId===roomId).length,0);
  assert.equal((await f.call('/api/notifications/read',member,{roomId})).status,404);
  f.advance(61_000);await f.app.notifications.poll();assert.equal(f.sent.length,0);
  assert.equal((await f.call('/api/notifications?after=NaN',owner)).status,400);
});
