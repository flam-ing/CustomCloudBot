import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHostAdmin } from '../host-admin.mjs';

const OWNER='11111111-1111-4111-8111-111111111111';
const INVITEE='22222222-2222-4222-8222-222222222222';
const ROOM='33333333-3333-4333-8333-333333333333';
const OTHER_ROOM='44444444-4444-4444-8444-444444444444';
const actor={userId:OWNER,roomId:ROOM};
const env={COMMUNITY_HOST_ADMIN_SOCKET:'/tmp/host-admin-test.sock',COMMUNITY_HOST_ADMIN_USER_IDS:OWNER};
const reply=(body,overrides={})=>({scope:'host-root',requestId:body.requestId,stdout:'0\n',stderr:'',exitCode:0,...overrides});

function transport(respond=({res,body})=>{res.emit('data',Buffer.from(JSON.stringify(reply(body))));res.emit('end');}) {
  const calls=[];
  const requestImpl=(options,onResponse)=>{
    const req=new EventEmitter(),entry={options,req,body:null};calls.push(entry);
    const abort=()=>queueMicrotask(()=>req.emit('error',new Error('request aborted')));
    options.signal.addEventListener('abort',abort,{once:true});
    req.destroy=()=>{queueMicrotask(()=>req.emit('error',new Error('request destroyed')));return req;};
    req.end=raw=>{
      entry.body=JSON.parse(raw);
      queueMicrotask(()=>{
        const res=new EventEmitter();res.statusCode=200;
        entry.res=res;onResponse(res);
        respond({...entry,res});
      });
    };
    return req;
  };
  return {calls,requestImpl};
}
function fixture(options={}) {
  let role='admin',member=true;
  const wire=transport(options.respond);
  const api=createHostAdmin({env,getUser:id=>id===OWNER?{id,role}:{id,role:'admin'},hasMembership:(_userId,roomId)=>member&&roomId===ROOM,requestImpl:wire.requestImpl,...options.factory});
  return {api,...wire,role:value=>{role=value;},membership:value=>{member=value;}};
}

test('host administration is disabled without an explicit socket and owner account',async()=>{
  let calls=0;
  const api=createHostAdmin({env:{},getUser:()=>({role:'admin'}),hasMembership:()=>true,requestImpl:()=>{calls++;}});
  assert.equal(api.enabled,false);assert.equal(api.authorized(OWNER,ROOM),false);
  await assert.rejects(api.execute(actor,{command:'id -u'}),{status:403});
  assert.equal(calls,0);
});

test('incomplete or malformed host administration configuration fails closed',()=>{
  for(const configured of [
    {COMMUNITY_HOST_ADMIN_SOCKET:'/tmp/control.sock'},
    {COMMUNITY_HOST_ADMIN_USER_IDS:OWNER},
    {...env,COMMUNITY_HOST_ADMIN_USER_IDS:'admin'},
    {...env,COMMUNITY_HOST_ADMIN_USER_IDS:`${OWNER},invalid`},
    {...env,COMMUNITY_HOST_ADMIN_SOCKET:'relative.sock'},
    {...env,COMMUNITY_HOST_ADMIN_SOCKET:'/tmp/invalid\0.sock'},
  ])assert.throws(()=>createHostAdmin({env:configured}),/configuration|requires both/);
});

test('only an allowlisted administrator with current room membership can execute',async()=>{
  const f=fixture();
  assert.equal(f.api.authorized(OWNER,ROOM),true);
  assert.equal(f.api.authorized(INVITEE,ROOM),false,'an administrator outside the owner allowlist is not elevated');
  assert.equal(f.api.authorized(OWNER,OTHER_ROOM),false);
  await assert.rejects(f.api.execute({userId:INVITEE,roomId:ROOM},{command:'id -u'}),{status:403});
  await assert.rejects(f.api.execute({userId:INVITEE,roomId:ROOM},{command:'id -u',userId:OWNER,roomId:ROOM}),{status:403});
  await assert.rejects(f.api.execute({userId:OWNER,roomId:OTHER_ROOM},{command:'id -u'}),{status:403});
  f.role('member');
  await assert.rejects(f.api.execute(actor,{command:'id -u'}),{status:403});
  f.role('admin');f.membership(false);
  await assert.rejects(f.api.execute(actor,{command:'id -u'}),{status:403});
  assert.equal(f.calls.length,0);
});

test('a role or membership revoked after tool advertisement is rechecked before dispatch',async()=>{
  const f=fixture();
  assert.equal(f.api.authorized(OWNER,ROOM),true);
  f.role('member');
  await assert.rejects(f.api.execute(actor,{command:'id -u'}),{status:403});
  f.role('admin');assert.equal(f.api.authorized(OWNER,ROOM),true);f.membership(false);
  await assert.rejects(f.api.execute(actor,{command:'id -u'}),{status:403});
  assert.equal(f.calls.length,0);
});

test('invalid commands, paths, deadlines and model-supplied actor fields never reach the host',async()=>{
  const f=fixture();
  for(const args of [null,[],{}, {command:''},{command:'   '},{command:42},{command:'x'.repeat(16001)},
    {command:'id\0-u'},{command:'id',cwd:'tmp'},{command:'id',cwd:'/tmp\0x'},{command:'id',cwd:'/'+'x'.repeat(4096)},
    {command:'id',timeoutMs:999},{command:'id',timeoutMs:120001},{command:'id',timeoutMs:1000.5},{command:'id',timeoutMs:'1000'},
    {command:'id',userId:OWNER},{command:'id',roomId:ROOM},{command:'id',requestId:'forged'},{command:'id',environment:{ROOT:'1'}},
  ])await assert.rejects(f.api.execute(actor,args),{status:400});
  const allowed=createHostAdmin({env,getUser:()=>({role:'admin'}),hasMembership:()=>true,requestImpl:f.requestImpl});
  await assert.rejects(allowed.execute({userId:OWNER,roomId:'not-a-room'},{command:'id'}),{status:400});
  assert.equal(f.calls.length,0);
});

test('Unix socket request derives actor identity from server context and returns the matching host result',async t=>{
  const dir=await mkdtemp('/tmp/host-admin-'),socketPath=join(dir,'control.sock'),requests=[];
  const server=createServer((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      const body=JSON.parse(Buffer.concat(chunks).toString());requests.push({body,path:req.url,method:req.method,headers:req.headers});
      res.setHeader('content-type','application/json');res.end(JSON.stringify(reply(body)));
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const api=createHostAdmin({env:{...env,COMMUNITY_HOST_ADMIN_SOCKET:socketPath},getUser:id=>({id,role:'admin'}),hasMembership:(id,room)=>id===OWNER&&room===ROOM});
  const result=await api.execute(actor,{command:'id -u'});
  assert.equal(requests.length,1);const {body,path,method,headers}=requests[0];
  assert.equal(path,'/execute');assert.equal(method,'POST');assert.equal(headers['content-type'],'application/json');
  assert.equal(body.userId,OWNER);assert.equal(body.roomId,ROOM);assert.equal(body.command,'id -u');assert.equal(body.cwd,'/');assert.equal(body.timeoutMs,20000);
  assert.match(body.requestId,/^[a-f0-9-]{36}$/);assert.deepEqual(result,reply(body));
  assert.equal(Number(headers['content-length']),Buffer.byteLength(JSON.stringify(body)));
});

test('response identity, scope, format and errors are validated without a transport retry',async()=>{
  const cases=[
    ({res,body})=>{res.emit('data',Buffer.from(JSON.stringify(reply(body,{requestId:'another-request'}))));res.emit('end');},
    ({res,body})=>{res.emit('data',Buffer.from(JSON.stringify(reply(body,{scope:'desktop'}))));res.emit('end');},
    ({res,body})=>{res.emit('data',Buffer.from(JSON.stringify(reply(body,{stdout:null}))));res.emit('end');},
    ({res})=>{res.emit('data',Buffer.from('not json'));res.emit('end');},
    ({res})=>{res.statusCode=503;res.emit('data',Buffer.from('{}'));res.emit('end');},
    ({res})=>{res.emit('error',new Error('disconnected'));},
  ];
  for(const respond of cases){
    const f=fixture({respond});await assert.rejects(f.api.execute(actor,{command:'id'}),{status:502});assert.equal(f.calls.length,1);
  }
  const forbidden=fixture({respond:({res})=>{res.statusCode=403;res.emit('data',Buffer.from('{}'));res.emit('end');}});
  await assert.rejects(forbidden.api.execute(actor,{command:'id'}),{status:403});assert.equal(forbidden.calls.length,1);
});

test('oversized broker response is bounded and destroys the request without retrying',async()=>{
  const f=fixture({respond:({res})=>{res.emit('data',Buffer.alloc(128*1024));res.emit('data',Buffer.from('x'));}});
  await assert.rejects(f.api.execute(actor,{command:'id'}),{status:503});
  assert.equal(f.calls.length,1);
});

test('a cancelled request never starts and active cancellation reaches the socket without retrying',async()=>{
  const f=fixture({respond:()=>{}}),controller=new AbortController();controller.abort();
  await assert.rejects(f.api.execute(actor,{command:'id'},{signal:controller.signal}),{status:499});
  assert.equal(f.calls.length,0);
  const active=new AbortController();
  const pending=f.api.execute(actor,{command:'id'},{signal:active.signal});
  const rejected=assert.rejects(pending,{status:503});active.abort();await rejected;
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.signal.aborted,true);
});

test('a host request deadline aborts the transport after command deadline plus grace and never retries',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({respond:()=>{}}),pending=f.api.execute(actor,{command:'id',timeoutMs:1000});
  const rejected=assert.rejects(pending,{status:503});
  t.mock.timers.tick(5999);assert.equal(f.calls[0].options.signal.aborted,false);
  t.mock.timers.tick(1);await rejected;
  assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.calls.length,1);
});

test('synchronous request creation and write failures remove the deadline and abort listener',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const duringWrite of [false,true]){
    const outer=new AbortController();let requestSignal,calls=0,destroyed=0;
    const f=fixture({factory:{requestImpl:options=>{
      calls++;requestSignal=options.signal;
      if(!duringWrite)throw new Error('private transport detail');
      const req=new EventEmitter();req.end=()=>{throw new Error('private write detail');};req.destroy=()=>{destroyed++;};return req;
    }}});
    await assert.rejects(f.api.execute(actor,{command:'id',timeoutMs:1000},{signal:outer.signal}),error=>{
      assert.equal(error.status,503);assert.ok(!error.message.includes('private'));return true;
    });
    assert.equal(getEventListeners(outer.signal,'abort').length,0);
    t.mock.timers.tick(6000);outer.abort();
    assert.equal(requestSignal.aborted,false,'settled request must not retain deadline or outer abort callback');
    assert.equal(calls,1);assert.equal(destroyed,Number(duringWrite));
  }
});
