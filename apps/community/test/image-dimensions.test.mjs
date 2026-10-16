import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageDimensions, storedImageDimensions, createImageDimensionReader } from "../media.mjs";
import { startCommunity } from "../server.mjs";

const u16be = (n) => Buffer.from([n >> 8, n & 255]);
function png(width, height) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), ihdr, Buffer.alloc(4)]);
}
function jpeg(width, height, orientation) {
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(Buffer.from([0xff, 0xe0]), u16be(16), Buffer.from("JFIF\0"), Buffer.alloc(9));
  if (orientation) {
    // Big-endian TIFF with one IFD entry: Orientation (0x0112), SHORT, count 1.
    const tiff = Buffer.concat([Buffer.from("MM"), u16be(42), Buffer.from([0, 0, 0, 8]), u16be(1), u16be(0x0112), u16be(3), Buffer.from([0, 0, 0, 1]), u16be(orientation), u16be(0), Buffer.alloc(4)]);
    const body = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
    parts.push(Buffer.from([0xff, 0xe1]), u16be(body.length + 2), body);
  }
  parts.push(Buffer.from([0xff, 0xc0]), u16be(17), Buffer.from([8]), u16be(height), u16be(width), Buffer.from([3]), Buffer.alloc(9));
  parts.push(Buffer.from([0xff, 0xda]), u16be(2));
  return Buffer.concat(parts);
}
function webp(chunk, payload) {
  const head = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from(chunk), Buffer.alloc(4)]);
  return Buffer.concat([head, payload]);
}

test("picture headers report the size the browser will draw", async () => {
  assert.deepEqual(imageDimensions(await readFile(new URL("../public/icons/cloud-agent-v1-512.png", import.meta.url)), "image/png"), { width: 512, height: 512 });
  assert.deepEqual(imageDimensions(png(2400, 300), "image/png"), { width: 2400, height: 300 });
  assert.deepEqual(imageDimensions(Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(4)]), "image/gif"), { width: 320, height: 240 });
  assert.deepEqual(imageDimensions(jpeg(1200, 900), "image/jpeg"), { width: 1200, height: 900 });
  // A phone photo stored sideways (EXIF orientation 6) is shown upright, so the sides swap.
  assert.deepEqual(imageDimensions(jpeg(4032, 3024, 6), "image/jpeg"), { width: 3024, height: 4032 });
  assert.deepEqual(imageDimensions(jpeg(4032, 3024, 1), "image/jpeg"), { width: 4032, height: 3024 });
  const vp8 = Buffer.alloc(10); vp8.writeUInt16LE(640, 6); vp8.writeUInt16LE(480, 8);
  assert.deepEqual(imageDimensions(webp("VP8 ", Buffer.concat([vp8, Buffer.alloc(4)])), "image/webp"), { width: 640, height: 480 });
  const vp8x = Buffer.alloc(14); vp8x.writeUIntLE(799, 4, 3); vp8x.writeUIntLE(599, 7, 3);
  assert.deepEqual(imageDimensions(webp("VP8X", vp8x), "image/webp"), { width: 800, height: 600 });
  // VP8L packs 14-bit width-1 and height-1 after the 0x2f signature byte.
  const w = 100 - 1, h = 50 - 1, bits = w | (h << 14);
  const vp8l = Buffer.from([0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255, 0, 0, 0, 0]);
  assert.deepEqual(imageDimensions(webp("VP8L", vp8l), "image/webp"), { width: 100, height: 50 });
  for (const [buf, mime] of [[Buffer.from("not a picture"), "image/png"], [Buffer.alloc(0), "image/jpeg"], [Buffer.from([0xff, 0xd8, 0x00]), "image/jpeg"], [png(0, 10), "image/png"], ["text", "image/png"]]) assert.equal(imageDimensions(buf, mime), null);
});

test("stored picture sizes are read from the file header once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "community-image-size-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "picture");
  await writeFile(path, jpeg(300, 200, 8));
  assert.deepEqual(await storedImageDimensions(path, "image/jpeg"), { width: 200, height: 300 });
  await writeFile(path, png(1, 1));
  assert.deepEqual(await storedImageDimensions(path, "image/jpeg"), { width: 200, height: 300 }, "files are immutable once stored, so the first answer is kept");
  assert.equal(await storedImageDimensions(join(dir, "missing"), "image/png"), null);
});

test("header reads coalesce shared files and never open more than eight at once",async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  let active=0,peak=0,opens=0,closes=0;
  const bytes=png(240,160);
  const read=createImageDimensionReader({openFile:async()=>{
    opens++;active++;peak=Math.max(peak,active);
    return {async read(buffer){await gate;bytes.copy(buffer);return {bytesRead:bytes.length};},async close(){active--;closes++;}};
  }});
  const first=read('shared','image/png');
  assert.equal(read('shared','image/png'),first);
  const requests=[first,...Array.from({length:15},(_,index)=>read('file-'+index,'image/png'))];
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(opens,8);assert.equal(peak,8);
  release();
  for(const result of await Promise.all(requests))assert.deepEqual(result,{width:240,height:160});
  assert.equal(opens,16);assert.equal(closes,16);assert.equal(active,0);assert.equal(peak,8);
  assert.deepEqual(await read('shared','image/png'),{width:240,height:160});assert.equal(opens,16);
});

test("dimension hints reject malformed or oversized headers without exposing metadata", () => {
  const badPng = png(10, 20); badPng.fill(0, 0, 8);
  assert.equal(imageDimensions(badPng, "image/png"), null);
  assert.equal(imageDimensions(png(65536, 20), "image/png"), null);
  assert.equal(imageDimensions(Buffer.alloc(16, 0xff), "image/gif"), null);
  const truncated = jpeg(400, 300, 6).subarray(0, 50);
  assert.equal(imageDimensions(truncated, "image/jpeg"), null);
  const invalidSegment = jpeg(400, 300); invalidSegment.writeUInt16BE(1, 4);
  assert.equal(imageDimensions(invalidSegment, "image/jpeg"), null);
  const invalidExif = jpeg(400, 300, 6);
  const tiff = invalidExif.indexOf(Buffer.from("Exif\0\0")) + 6;
  invalidExif.writeUInt32BE(0xffffffff, tiff + 4);
  assert.deepEqual(imageDimensions(invalidExif, "image/jpeg"), {width:400,height:300});
});

test("uploads and room history include picture sizes but never the stored path", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "community-image-api-"));
  const app = await startCommunity({ dataDir, port: 0, env: { COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap" } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const register = await fetch(`${app.url}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "picture_owner", displayName: "사진", password: "correct horse battery staple", inviteToken: "bootstrap" }) });
  const auth = { cookie: register.headers.get("set-cookie").split(";", 1)[0], "x-csrf-token": (await register.json()).csrfToken };
  const headers = { cookie: auth.cookie, "x-csrf-token": auth["x-csrf-token"] };
  const room = (await (await fetch(`${app.url}/api/rooms`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "사진 방", description: "" }) })).json()).room.id;
  const form = new FormData(); form.append("file", new Blob([png(1600, 900)], { type: "image/png" }), "wide.png");
  const upload = await fetch(`${app.url}/api/rooms/${room}/attachments`, { method: "POST", headers, body: form });
  assert.equal(upload.status, 201);
  const attachment = (await upload.json()).attachment;
  assert.equal(attachment.width, 1600); assert.equal(attachment.height, 900); assert.equal(Object.hasOwn(attachment, "path"), false);
  const sent = await fetch(`${app.url}/api/rooms/${room}/messages`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ text: "", attachmentIds: [attachment.id], botIds: [], clientNonce: "picture-nonce" }) });
  assert.ok(sent.status < 300, `message accepted (${sent.status})`);
  const data = await (await fetch(`${app.url}/api/rooms/${room}`, { headers })).json();
  const listed = data.messages.flatMap((message) => message.attachments).find((item) => item.id === attachment.id);
  assert.deepEqual({ width: listed.width, height: listed.height }, { width: 1600, height: 900 });
  assert.equal(Object.hasOwn(listed, "path"), false);
});

async function imageFixture(t,readDimensions){
  const dataDir=await mkdtemp(join(tmpdir(),'community-image-auth-'));
  const app=await startCommunity({dataDir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap'},readImageDimensions:readDimensions});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const registration=await fetch(app.url+'/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'image_auth',displayName:'사진',password:'image fixture password',inviteToken:'bootstrap'})});
  const actor=await registration.json(),headers={cookie:registration.headers.get('set-cookie').split(';')[0],'x-csrf-token':actor.csrfToken};
  const room=(await(await fetch(app.url+'/api/rooms',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'})).json()).room.id;
  const upload=()=>{const form=new FormData();form.append('file',new Blob([png(40,30)],{type:'image/png'}),'사진.png');return fetch(`${app.url}/api/rooms/${room}/attachments`,{method:'POST',headers,body:form});};
  return {app,dataDir,headers,room,upload};
}

for(const revoke of ['membership','session'])test(`history is withheld if ${revoke} is revoked during asynchronous image reads`,async t=>{
  let pause=false,entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await imageFixture(t,async()=>{if(pause){entered();await gate;}return {width:40,height:30};});
  const image=(await(await f.upload()).json()).attachment;
  const sent=await fetch(`${f.app.url}/api/rooms/${f.room}/messages`,{method:'POST',headers:{...f.headers,'content-type':'application/json'},body:JSON.stringify({text:'private image',attachmentIds:[image.id],botIds:[],clientNonce:'image-auth'})});
  assert.equal(sent.status,202);await sent.json();
  pause=true;
  const request=fetch(`${f.app.url}/api/rooms/${f.room}`,{headers:f.headers});
  await started;
  if(revoke==='membership')f.app.db.prepare('DELETE FROM room_members WHERE room_id=?').run(f.room);
  else{const logout=await fetch(f.app.url+'/api/logout',{method:'POST',headers:{...f.headers,'content-type':'application/json'},body:'{}'});assert.equal(logout.status,200);await logout.json();}
  release();
  const response=await request;
  assert.equal(response.status,revoke==='membership'?404:401);
  assert.equal((await response.json()).messages,undefined);
});

test('revoked image upload is cleaned before a database record or response can expose it',async t=>{
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await imageFixture(t,async()=>{entered();await gate;return {width:40,height:30};});
  const request=f.upload();await started;
  f.app.db.prepare('DELETE FROM room_members WHERE room_id=?').run(f.room);
  release();
  const response=await request;assert.equal(response.status,404);await response.json();
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM attachments').get().n,0);
  assert.deepEqual(await readdir(join(f.dataDir,'media')),[]);
});
