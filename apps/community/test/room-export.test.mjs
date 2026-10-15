import test from "node:test";
import assert from "node:assert/strict";
import {downloadRoomExport, exportFilename, formatRoomExport, loadRoomExport} from "../public/room-export.js";

const id="12345678-1234-4234-8234-123456789012";
const room={id,name:"프로젝트 기록"};
const message=(id,createdAt=1)=>({id,kind:"human",author:"민우",text:`내용 ${id}`,createdAt,clientNonceHash:"private",attachments:[]});

test("export reads every page using a stable snapshot and strips internal fields",async()=>{
  const paths=[],progress=[];
  const data=await loadRoomExport({roomId:id,onProgress:n=>progress.push(n),api:async path=>{
    paths.push(path);
    return paths.length===1?{room,messages:[message("second",2)],through:9,next:5}:{room,messages:[message("first",1)],through:9,next:null};
  }});
  assert.deepEqual(paths,[`/api/rooms/${id}/export`,`/api/rooms/${id}/export?after=5&through=9`]);
  assert.deepEqual(progress,[1,2]);assert.deepEqual(data.messages.map(m=>m.id),["first","second"]);
  assert.doesNotMatch(JSON.stringify(data),/private|clientNonce/);
});

test("stale account, revoked access and malformed pagination never produce partial downloads",async()=>{
  let current=true;
  await assert.rejects(loadRoomExport({roomId:id,isCurrent:()=>current,api:async()=>{current=false;return {room,messages:[message("1")],through:1,next:null};}}),{name:"AbortError"});
  let calls=0;
  await assert.rejects(loadRoomExport({roomId:id,api:async()=>{if(++calls===2)throw new Error("membership revoked");return {room,messages:[message("1")],through:2,next:1};}}),/membership revoked/);
  for(const bad of [{through:2,next:0},{through:2,next:3},{through:-1,next:null},{through:2,next:1,messages:[]}])await assert.rejects(loadRoomExport({roomId:id,api:async()=>({room,messages:[message("1")],...bad})}));
});

test("download formats retain all text while filenames and attachment URLs stay safe",()=>{
  const now=new Date("2026-10-16T04:00:00Z"),attachment={name:"photo [1].png",mime:"image/png",size:123,url:`/api/rooms/${id}/attachments/${id}`};
  const data={room,messages:[{...message("1"),attachments:[attachment,{name:"unsafe",url:"javascript:alert(1)"}]}]};
  const markdown=formatRoomExport(data,"markdown",{now,origin:"https://bots.example.test/path"});
  assert.match(markdown.text,/내용 1/);assert.ok(markdown.text.includes(`https://bots.example.test${attachment.url}`));assert.doesNotMatch(markdown.text,/javascript:/);
  assert.equal(markdown.filename,"프로젝트 기록-2026-10-16.md");
  const json=formatRoomExport(data,"json",{now});assert.equal(JSON.parse(json.text).messages.length,1);assert.equal(JSON.parse(json.text).exportedAt,now.toISOString());
  assert.equal(exportFilename("../../CON", "json", now),"대화-2026-10-16.json");
  assert.doesNotMatch(exportFilename("/bad\\name\n\u202e?*. ","markdown",now),/[\\/?*\u202e\n]/);
});

test("blob downloads remove temporary anchors and revoke object URLs",()=>{
  let clicked=0,removed=0,revoked=0,timer;
  const anchor={click(){clicked++;},remove(){removed++;}};
  downloadRoomExport({text:"record",mime:"text/plain",filename:"record.txt"},{doc:{body:{append(){}},createElement:()=>anchor},urlAPI:{createObjectURL:()=>"blob:fixture",revokeObjectURL:()=>revoked++},timers:{setTimeout:fn=>timer=fn}});
  assert.equal(clicked,1);assert.equal(removed,1);assert.equal(revoked,0);timer();assert.equal(revoked,1);assert.equal(anchor.download,"record.txt");
});
