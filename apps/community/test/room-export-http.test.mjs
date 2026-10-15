import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startCommunity} from "../server.mjs";
import {loadRoomExport} from "../public/room-export.js";

test("full transcript export is paginated, stable and checked against room membership on every request",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"room-export-"));
  const app=await startCommunity({dataDir:dir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:"bootstrap"},llm:{complete:async()=>"unused"}});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  async function call(path,auth,body){
    const res=await fetch(app.url+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json",...(auth?{cookie:auth.cookie,"x-csrf-token":auth.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,data:await res.json(),res};
  }
  async function register(username,admin){
    const inviteToken=admin?(await call("/api/admin/invites",admin,{})).data.token:"bootstrap";
    const result=await call("/api/register",null,{username,displayName:username,password:"export-fixture-password",inviteToken});assert.equal(result.status,201);
    return {id:result.data.user.id,csrf:result.data.csrfToken,cookie:result.res.headers.get("set-cookie").split(";")[0]};
  }
  const owner=await register("export_owner"),member=await register("export_member",owner),outsider=await register("export_outsider",owner);
  const room=(await call("/api/rooms",owner,{name:"Full history"})).data.room.id;
  const invite=(await call(`/api/rooms/${room}/invites`,owner,{})).data.token;
  assert.equal((await call("/api/rooms/join",member,{token:invite})).status,200);
  const insert=app.db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)");
  for(let i=0;i<405;i++)insert.run(randomUUID(),room,"human",owner.id,"Owner",`record-${i}`,`private-nonce-${i}`,i+1);
  const first=await call(`/api/rooms/${room}/export`,member);
  assert.equal(first.status,200);assert.equal(first.data.messages.length,200);assert.ok(first.data.next);
  assert.doesNotMatch(JSON.stringify(first.data),/private-nonce|clientNonce|authorId|csrf|apiKey/);
  const count=app.db.prepare("SELECT count(*) n FROM messages WHERE room_id=?").get(room).n;
  insert.run(randomUUID(),room,"human",owner.id,"Owner","late-message","late-private",10000);
  const collected=[...first.data.messages];let page=first.data;
  while(page.next!==null){page=(await call(`/api/rooms/${room}/export?after=${page.next}&through=${page.through}`,member)).data;collected.push(...page.messages);}
  assert.equal(collected.length,count);assert.ok(collected.some(m=>m.text==="record-0"));assert.ok(collected.some(m=>m.text==="record-404"));assert.ok(!collected.some(m=>m.text==="late-message"));
  const full=await loadRoomExport({roomId:room,api:async path=>{const result=await call(path,member);assert.equal(result.status,200);return result.data;}});assert.equal(full.messages.length,count+1);
  assert.equal((await call(`/api/rooms/${room}/export`,null)).status,401);
  assert.equal((await call(`/api/rooms/${room}/export`,outsider)).status,404);
  for(const query of ["after=-1","after=1","through=nope","after=3&through=2"])assert.equal((await call(`/api/rooms/${room}/export?${query}`,member)).status,400);
  app.db.prepare("DELETE FROM room_members WHERE room_id=? AND user_id=?").run(room,member.id);
  assert.equal((await call(`/api/rooms/${room}/export?after=${first.data.next}&through=${first.data.through}`,member)).status,404);
  assert.equal((await fetch(app.url+"/room-export.js")).status,200);
});
