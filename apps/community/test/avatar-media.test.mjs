import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {deflateSync} from "node:zlib";
import {AVATAR_MAX_BYTES, validateAvatarBytes} from "../avatar-media.mjs";

const fixture = name => readFile(new URL("../public/" + name, import.meta.url));
function chunk(type, payload) {
  const bytes = Buffer.alloc(payload.length + 12); bytes.writeUInt32BE(payload.length); bytes.write(type, 4); payload.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function png(width, height, pixels) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

test("avatar validation accepts static PNG, JPEG and WebP files with bounded dimensions", async () => {
  for (const [file, mime, width] of [["icons/cloud-agent-v1-48.png", "image/png", 48], ["media/agent/idle-poster.jpg", "image/jpeg", 320], ["media/agent/idle-poster.webp", "image/webp", 300]]) {
    const result = validateAvatarBytes(await fixture(file), mime);
    assert.deepEqual(result, {mime, width, height: width});
  }
});

test("avatar validation rejects non-raster content, MIME mismatches, corrupt/truncated files and trailing payloads", async () => {
  const valid = await fixture("icons/cloud-agent-v1-48.png"), damaged = Buffer.from(valid); damaged[32] ^= 1;
  const bad = [[Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml"], [valid, "image/jpeg"], [damaged, "image/png"], [valid.subarray(0, -1), "image/png"], [Buffer.alloc(AVATAR_MAX_BYTES + 1), "image/png"]];
  for (const [path, mime] of [["media/agent/idle-poster.jpg", "image/jpeg"], ["media/agent/idle-poster.webp", "image/webp"]]) {
    const bytes = await fixture(path);
    bad.push([bytes.subarray(0, -1), mime], [Buffer.concat([bytes, Buffer.from("<script>bad</script>")]), mime]);
  }
  for (const [bytes, mime] of bad) assert.throws(() => validateAvatarBytes(bytes, mime), {status: 415});
});

test("PNG validation bounds inflation and rejects invalid dimensions, scanline sizes and filters", () => {
  assert.deepEqual(validateAvatarBytes(png(1, 1, Buffer.from([0, 10, 20, 30, 255])), "image/png"), {mime: "image/png", width: 1, height: 1});
  for (const bytes of [png(0, 1, Buffer.alloc(5)), png(4097, 1, Buffer.alloc(5)), png(1, 1, Buffer.alloc(4)), png(1, 1, Buffer.alloc(1000000)), png(1, 1, Buffer.from([5, 10, 20, 30, 255]))])
    assert.throws(() => validateAvatarBytes(bytes, "image/png"), {status: 415});
});
