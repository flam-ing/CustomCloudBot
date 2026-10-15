import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createNotifications} from '../notifications.mjs';

const START=Date.parse('2026-10-17T12:00:00Z');
const A={id:'user-a',role:'admin'}, B={id:'user-b',role:'member'};
function fixture(t,{configured=true}={}) {
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT);
    CREATE TABLE rooms(id TEXT PRIMARY KEY,name TEXT,owner_id TEXT,private INTEGER,mail INTEGER);
    CREATE TABLE room_members(room_id TEXT,user_id TEXT);
    CREATE TABLE mail_agent_config(id INTEGER PRIMARY KEY,senders TEXT);`);
  for(const user of [A,B])db.prepare('INSERT INTO users VALUES(?,?)').run(user.id,user.role);
  db.prepare('INSERT INTO rooms VALUES(?,?,?,?,?)').run('shared','PRIVATE_ROOM_TITLE',A.id,0,0);
  for(const user of [A,B])db.prepare('INSERT INTO room_members VALUES(?,?)').run('shared',user.id);
  const state={now:START,fail:false},calls=[];
  db.prepare('INSERT INTO mail_agent_config VALUES(1,?)').run(JSON.stringify([{email:'owner@example.test',userId:A.id},{email:'member@example.test',userId:B.id}]));
  function roomFor(id,user) {
    const room=db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
    if(!room || !db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').get(id,user.id) || ((room.private || room.mail) && room.owner_id!==user.id))throw new Error('No access');
    return room;
  }
  const mailbox={configured,async send(input){calls.push(input);if(state.fail)throw new Error('PRIVATE provider secret');return {accepted:true};}};
  const options={db,mailbox,roomFor,canEmailRoom:room=>!room.mail,now:()=>state.now,getOrigin:()=> 'https://app.example.test',getName:()=> 'TestBot'};
  const f={db,state,calls,mailbox,options,service:createNotifications(options)};
  f.emit=(id,extra={})=>f.service.emit({roomId:'shared',messageId:id,kind:'bot',...extra});
  f.advance=n=>{state.now+=n;};
  f.restart=async()=>{await f.service.close();f.service=createNotifications(options);};
  f.row=id=>db.prepare('SELECT * FROM notification_events WHERE user_id=? AND id=?').get(A.id,`message:shared:${id}`);
  t.after(async()=>{await f.service.close();db.close();});
  return f;
}

test('preferences default to sound only and validate changes without accepting a custom recipient',async t=>{
  const f=fixture(t);
  assert.deepEqual(f.service.settings(A),{soundEnabled:true,emailEnabled:false,emailAddress:'owner@example.test',emailConfigured:true});
  for(const value of [{},{soundEnabled:1},{emailAddress:'attacker@example.test'},{emailEnabled:true,emailAddress:'attacker@example.test'}])assert.throws(()=>f.service.configure(A,value),{status:400});
  f.service.configure(A,{soundEnabled:false,emailEnabled:true});
  await f.restart();assert.equal(f.service.settings(A).soundEnabled,false);assert.equal(f.service.settings(A).emailEnabled,true);
  assert.equal(f.service.settings(B).soundEnabled,true);assert.equal(f.service.settings(B).emailEnabled,false);
  f.db.prepare('UPDATE mail_agent_config SET senders=?').run('[]');
  assert.throws(()=>f.service.configure(A,{emailEnabled:true}),{status:409});
  assert.equal(f.service.configure(A,{soundEnabled:true}).soundEnabled,true,'loss of email mapping does not block a sound change');
  assert.equal(f.service.configure(A,{emailEnabled:false}).emailEnabled,false);
});

test('feed excludes own human messages, deduplicates IDs, pages and never stores conversation text',t=>{
  const f=fixture(t);f.emit('human',{kind:'human',authorId:A.id});f.emit('answer');f.emit('answer');f.emit('status',{kind:'system'});
  const a=f.service.list(A),b=f.service.list(B);
  assert.equal(a.items.length,2);assert.equal(b.items.length,3);
  assert.equal(b.items[0].id,'message:shared:human');
  assert.deepEqual(Object.keys(a.items[0]).sort(),['at','id','kind','read','roomId','roomName','sequence','title'].sort());
  assert.ok(a.items.every(item=>item.read===false));
  assert.deepEqual(f.service.list(A,String(a.cursor)),{items:[],cursor:a.cursor});
  f.emit('next');assert.equal(f.service.list(A,String(a.cursor)).items.length,1);
  for(const cursor of ['-1','1.5','NaN','9007199254740992','01'])assert.throws(()=>f.service.list(A,cursor),{status:400});
  for(let i=0;i<110;i++)f.emit('page-'+i);
  assert.equal(f.service.list(A).items.length,50);assert.equal(f.service.list(A,'0').items.length,100);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM notification_events').all()).includes('PRIVATE_ROOM_TITLE'),'only feed projects current accessible room title');
});

test('read ownership and permission revocation protect feed and pending email including stale private/mail membership',async t=>{
  const f=fixture(t);f.service.configure(B,{emailEnabled:true});f.emit('one');
  const aId=f.service.list(A).items[0].id;
  assert.deepEqual(f.service.markRead(A,{ids:[aId]}),{read:1});assert.equal(f.service.list(B).items[0].read,false);
  f.db.prepare('UPDATE rooms SET private=1 WHERE id=?').run('shared');
  assert.equal(f.service.list(B).items.length,0);assert.deepEqual(f.service.markRead(B,{ids:[aId]}),{read:0});
  assert.throws(()=>f.service.markRead(B,{roomId:'shared'}),{status:404});
  f.advance(61_000);await f.service.poll();assert.equal(f.calls.length,0);
  f.emit('private');assert.equal(f.db.prepare('SELECT count(*) n FROM notification_events WHERE user_id=?').get(B.id).n,1);
  f.db.prepare('UPDATE rooms SET private=0,mail=1 WHERE id=?').run('shared');f.emit('mail');assert.equal(f.service.list(B).items.length,0);
  f.db.prepare('UPDATE rooms SET mail=0 WHERE id=?').run('shared');f.emit('revoked');
  f.db.prepare('DELETE FROM room_members WHERE user_id=?').run(B.id);f.advance(61_000);await f.service.poll();assert.equal(f.calls.length,0);
});

test('email is opt-in, delayed and generic; one notice covers a burst and later sends are throttled',async t=>{
  const f=fixture(t);f.emit('before-opt-in');f.service.configure(A,{emailEnabled:true});
  f.emit('one');f.emit('two');await f.service.poll();assert.equal(f.calls.length,0);
  f.advance(59_999);await f.service.poll();assert.equal(f.calls.length,0);
  f.advance(1);await f.service.poll();assert.equal(f.calls.length,1);
  const mail=f.calls[0];assert.equal(mail.to,'owner@example.test');assert.equal(mail.action,'send');assert.equal(mail.automatic,true);
  assert.match(mail.requestId,/^notification-[a-f0-9]{64}$/);assert.match(mail.text,/https:\/\/app\.example\.test\/\?room=shared/);
  assert.ok(!JSON.stringify(mail).includes('PRIVATE_ROOM_TITLE'));assert.equal(f.row('before-opt-in').email_state,'none');assert.equal(f.row('two').email_state,'suppressed');
  f.emit('later');f.advance(61_000);await f.service.poll();assert.equal(f.calls.length,1);
  f.advance(239_000);await f.service.poll();assert.equal(f.calls.length,2);
});

test('viewed, disabled, unmapped and mail-task room events never generate an email',async t=>{
  const f=fixture(t);f.service.configure(A,{emailEnabled:true});f.emit('read');
  f.service.markRead(A,{roomId:'shared'});f.advance(61_000);await f.service.poll();assert.equal(f.calls.length,0);
  f.emit('off');f.service.configure(A,{emailEnabled:false});f.advance(61_000);await f.service.poll();assert.equal(f.calls.length,0);
  f.service.configure(A,{emailEnabled:true});f.emit('mapping');
  f.db.prepare('UPDATE mail_agent_config SET senders=?').run(JSON.stringify([{email:'changed@example.test',userId:A.id}]));
  f.advance(61_000);await f.service.poll();assert.equal(f.calls.length,0);
  f.db.prepare('UPDATE rooms SET mail=1 WHERE id=?').run('shared');f.emit('mail-task');f.advance(61_000);await f.service.poll();assert.equal(f.calls.length,0);
  assert.ok(f.service.list(A).items.some(item=>item.id.endsWith(':mail-task')),'mail-task remains visible in-app');
});

test('uncertain send retries the exact durable request after restart without repeated notifications',async t=>{
  const f=fixture(t);f.service.configure(A,{emailEnabled:true});f.emit('retry');f.state.fail=true;
  f.advance(60_000);await f.service.poll();assert.equal(f.row('retry').email_state,'retry');assert.equal(f.calls.length,1);
  await f.restart();f.state.fail=false;f.advance(300_000);await f.service.poll();assert.equal(f.calls.length,2);
  assert.deepEqual(f.calls[1],f.calls[0]);assert.equal(f.row('retry').email_state,'sent');
  await f.service.poll();assert.equal(f.calls.length,2);
});

test('restart recovers an interrupted sending state with the same identity and stale unsent mail is discarded',async t=>{
  const f=fixture(t);f.service.configure(A,{emailEnabled:true});f.emit('interrupted');
  f.advance(60_000);await f.service.poll();assert.equal(f.calls.length,1);
  // Simulate losing the acknowledgement after upstream accepted the request.
  f.db.prepare("UPDATE notification_events SET email_state='sending' WHERE sequence=?").run(f.row('interrupted').sequence);
  await f.restart();f.advance(300_000);await f.service.poll();assert.deepEqual(f.calls[1],f.calls[0]);
  f.emit('stale');f.advance(24*60*60_000);await f.service.poll();assert.equal(f.calls.length,2);
  assert.equal(f.row('stale').email_state,'suppressed');
});

test('read or opt-out during a failed delivery suppresses retry and max attempts stop errors without storing provider details',async t=>{
  const f=fixture(t);f.service.configure(A,{emailEnabled:true});f.state.fail=true;f.emit('limit');
  for(let i=0;i<6;i++){f.advance(3_600_000);await f.service.poll();}
  assert.equal(f.calls.length,5);assert.equal(f.row('limit').email_state,'uncertain');
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM notification_events').all()).includes('PRIVATE provider'));
  f.emit('read-retry');f.advance(60_000);await f.service.poll();const count=f.calls.length;
  f.service.markRead(A,{all:true});f.advance(3_600_000);await f.service.poll();assert.equal(f.calls.length,count);
  f.emit('off-retry');f.advance(60_000);await f.service.poll();const count2=f.calls.length;
  f.service.configure(A,{emailEnabled:false});f.advance(3_600_000);await f.service.poll();assert.equal(f.calls.length,count2);
});

test('a retry burst cannot starve other rooms and expired events prune without configured mail',async t=>{
  const f=fixture(t);f.service.configure(A,{emailEnabled:true});f.emit('retry');f.state.fail=true;f.advance(60_000);await f.service.poll();
  for(let i=0;i<110;i++)f.emit('burst-'+i);
  f.db.prepare('INSERT INTO rooms VALUES(?,?,?,?,?)').run('other','Other',A.id,0,0);f.db.prepare('INSERT INTO room_members VALUES(?,?)').run('other',A.id);
  f.emit('other',{roomId:'other'});f.state.fail=false;f.advance(60_000);await f.service.poll();
  assert.equal(f.calls.length,2);assert.match(f.calls[1].text,/room=other/);
  f.mailbox.configured=false;f.advance(31*86400_000);await f.service.poll();
  assert.equal(f.db.prepare('SELECT count(*) n FROM notification_events').get().n,0);
});

test('closing prevents new notices and future email attempts',async t=>{
  const f=fixture(t);f.service.configure(A,{emailEnabled:true});f.emit('one');await f.service.close();f.advance(61_000);await f.service.poll();f.emit('two');
  assert.equal(f.calls.length,0);assert.equal(f.service.list(A).items.length,1);
});
