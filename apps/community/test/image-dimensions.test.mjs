import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageDimensions, storedImageDimensions } from "../media.mjs";
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
  assert.deepEqual(storedImageDimensions(path, "image/jpeg"), { width: 200, height: 300 });
  await writeFile(path, png(1, 1));
  assert.deepEqual(storedImageDimensions(path, "image/jpeg"), { width: 200, height: 300 }, "files are immutable once stored, so the first answer is kept");
  assert.equal(storedImageDimensions(join(dir, "missing"), "image/png"), null);
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
