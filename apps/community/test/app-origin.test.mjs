import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest,createServer} from 'node:http';
import WebSocket,{WebSocketServer} from 'ws';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

const canonical='https://bots.example.test', installed='https://192.0.2.10';
function request(app,{host='bots.example.test',origin,path='/api/health',method='GET',headers={},body}={}){
  return new Promise((resolve,reject)=>{
    const data=body===undefined?undefined:JSON.stringify(body);
    const req=httpRequest(new URL(path,app.url),{method,headers:{host,...(origin===undefined?{}:{origin}),...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...headers}},res=>{
      const parts=[];res.on('data',chunk=>parts.push(chunk));res.on('end',()=>{const text=Buffer.concat(parts).toString();let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,json});});
    });req.on('error',reject);req.end(data);
  });
}
async function fixture(t,env={}){
  const dataDir=await mkdtemp(join(tmpdir(),'community-app-origin-'));
  const app=await startCommunity({dataDir,port:0,env:{COMMUNITY_ORIGIN:canonical,COMMUNITY_APP_ORIGIN:installed,COMMUNITY_BOOTSTRAP_TOKEN:'origin-fixture',...env}});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});return app;
}

test('canonical web and explicitly configured installed-app hosts each accept their own origin',async t=>{
  const app=await fixture(t);
  for(const [host,origin]of[['bots.example.test',canonical],['192.0.2.10',installed]]){
    const result=await request(app,{host,origin});assert.equal(result.status,200);assert.equal(result.json.ok,true);
    const navigation=await request(app,{host,path:'/',headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});assert.equal(navigation.status,200);
  }
});

test('allowed origins are host-bound, never a cross-origin allowlist',async t=>{
  const app=await fixture(t);
  for(const value of[
    {host:'bots.example.test',origin:installed},
    {host:'192.0.2.10',origin:canonical},
    {host:'unrelated.example.test',origin:canonical},
    {host:'bots.example.test',origin:'https://unrelated.example.test'},
    {host:'bots.example.test',origin:'null'},
    {host:'bots.example.test',origin:installed,headers:{'x-forwarded-host':'192.0.2.10'}},
    {host:'192.0.2.10',origin:canonical,headers:{'x-forwarded-host':'bots.example.test'}},
  ])assert.equal((await request(app,value)).status,403,JSON.stringify(value));
});

test('host-specific app support does not relax cross-site API or subresource protection',async t=>{
  const app=await fixture(t);
  for(const host of['bots.example.test','192.0.2.10']){
    const blocked=await request(app,{host,headers:{'sec-fetch-site':'cross-site'}});assert.equal(blocked.status,403);
    const script=await request(app,{host,path:'/app.js',headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'no-cors','sec-fetch-dest':'script'}});assert.equal(script.status,403);
  }
});

test('browser and app authentication cookies remain secure and host-only',async t=>{
  const app=await fixture(t),body={username:'origin_fixture_user',displayName:'Fixture',password:'fixture-long-password',inviteToken:'origin-fixture'};
  const registration=await request(app,{host:'bots.example.test',origin:canonical,path:'/api/register',method:'POST',body});assert.equal(registration.status,201);
  const login=await request(app,{host:'192.0.2.10',origin:installed,path:'/api/login',method:'POST',body:{username:body.username,password:body.password}});assert.equal(login.status,200);
  for(const result of[registration,login]){
    const cookies=result.headers['set-cookie']||[];assert.ok(cookies.length);for(const cookie of cookies){assert.match(cookie,/;\s*Secure(?:;|$)/i);assert.match(cookie,/;\s*HttpOnly(?:;|$)/i);assert.doesNotMatch(cookie,/;\s*Domain=/i);}
  }
});

test('internal no-origin release health probes do not open other unknown-host routes',async t=>{
  const app=await fixture(t),host='127.0.0.1:8787';
  for(const probeHost of[host,'localhost:8787','[::1]:8787']){const health=await request(app,{host:probeHost});assert.equal(health.status,200);assert.equal(health.json.ok,true);}
  for(const unknownHost of['unrelated.example.test','127.0.0.1.evil.example','localhost.evil.example'])assert.equal((await request(app,{host:unknownHost})).status,403);
  for(const path of['/api/brand','/api/session','/app.js','/'])assert.equal((await request(app,{host,path})).status,403,path);
  assert.equal((await request(app,{host,origin:canonical})).status,403);
  assert.equal((await request(app,{host,headers:{'sec-fetch-site':'cross-site'}})).status,403);
});


test('installed-app desktop upgrades use their request Host and retain exact Origin binding',async t=>{
  const remote=createServer(),wss=new WebSocketServer({server:remote});
  await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const client of wss.clients)client.terminate();wss.close();await new Promise(resolve=>remote.close(resolve));});
  const remotePort=remote.address().port,room='11111111-2222-4333-8444-555555555555';
  const app=await fixture(t,{COMMUNITY_INITIAL_ROOM_ID:room,COMMUNITY_DESKTOP_MAP:JSON.stringify({[room]:{wsUrl:`ws://127.0.0.1:${remotePort}`,cdpUrl:`http://127.0.0.1:${remotePort}`}})});
  const registration=await request(app,{host:'192.0.2.10',origin:installed,path:'/api/register',method:'POST',body:{username:'upgrade_fixture',displayName:'Fixture',password:'fixture-long-password',inviteToken:'origin-fixture'}});
  assert.equal(registration.status,201);
  const cookie=registration.headers['set-cookie'][0].split(';')[0],csrf=registration.json.csrfToken;
  const ticket=await request(app,{host:'192.0.2.10',origin:installed,path:`/api/rooms/${room}/desktop/ticket`,method:'POST',headers:{cookie,'x-csrf-token':csrf},body:{view:'browser'}});assert.equal(ticket.status,201);
  const endpoint=app.url.replace(/^http/,'ws')+ticket.json.websocketPath;
  const connect=origin=>new Promise((resolve,reject)=>{
    const socket=new WebSocket(endpoint,{headers:{host:'192.0.2.10',origin,cookie}});
    const timer=setTimeout(()=>{socket.terminate();reject(Error('Desktop handshake timed out'));},2000);
    socket.once('open',()=>{clearTimeout(timer);resolve({socket,opened:true});});
    socket.once('unexpected-response',(_request,response)=>{clearTimeout(timer);socket.terminate();resolve({socket,opened:false,status:response.statusCode});});
    socket.once('error',()=>{});
  });
  const wrong=await connect(canonical);assert.equal(wrong.opened,false);assert.equal(wrong.status,403);
  const valid=await connect(installed);assert.equal(valid.opened,true);valid.socket.close();
});
