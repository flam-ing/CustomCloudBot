import {inflateSync} from "node:zlib";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const invalid = () => { throw Object.assign(new Error("올바른 PNG, JPEG 또는 WebP 사진을 선택해 주세요."), {status: 415}); };
const dimensions = (width, height) => {
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16777216) invalid();
  return {width, height};
};
const crcTable = Array.from({length: 256}, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; };

function png(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) invalid();
  let offset = 8, info, bits, color, interlace, ended = false, palette = false, dataEnded = false;
  const data = [];
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) invalid();
    const type = bytes.toString("ascii", offset + 4, offset + 8), chunk = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (!info && type !== "IHDR") invalid();
    if (type === "IHDR") {
      if (info || size !== 13) invalid();
      info = dimensions(chunk.readUInt32BE(0), chunk.readUInt32BE(4));
      bits = chunk[8]; color = chunk[9]; interlace = chunk[12];
      if (!( {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]}[color] || []).includes(bits) || chunk[10] || chunk[11] || interlace > 1) invalid();
    } else if (type === "PLTE") {
      if (data.length || !size || size % 3 || size > 768) invalid(); palette = true;
    } else if (type === "IDAT") {
      if (dataEnded || color === 3 && !palette) invalid(); data.push(chunk);
    } else if (type === "IEND") {
      if (size || !data.length || end !== bytes.length) invalid(); ended = true; break;
    } else {
      if (data.length) dataEnded = true;
      if (type === "acTL" || type[0] === type[0].toUpperCase()) invalid();
    }
    offset = end;
  }
  if (!ended) invalid();
  const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color];
  const passes = interlace ? [[0,0,8,8], [4,0,8,8], [0,4,4,8], [2,0,4,4], [0,2,2,4], [1,0,2,2], [0,1,1,2]] : [[0,0,1,1]];
  const rows = passes.map(([x,y,dx,dy]) => {
    const width = Math.max(0, Math.ceil((info.width - x) / dx)), height = Math.max(0, Math.ceil((info.height - y) / dy));
    return {size: Math.ceil(width * channels * bits / 8) + 1, count: width ? height : 0};
  });
  const size = rows.reduce((sum, row) => sum + row.size * row.count, 0);
  const pixels = inflateSync(Buffer.concat(data), {maxOutputLength: size});
  if (pixels.length !== size) invalid();
  let cursor = 0;
  for (const row of rows) for (let y = 0; y < row.count; y++) { if (pixels[cursor] > 4) invalid(); cursor += row.size; }
  return info;
}

function jpeg(bytes) {
  if (bytes.readUInt16BE(0) !== 0xffd8) invalid();
  let offset = 2, info, scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) { if (!info || !scan || offset !== bytes.length) invalid(); return info; }
    if (marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > bytes.length) invalid();
    const size = bytes.readUInt16BE(offset), end = offset + size;
    if (size < 2 || end > bytes.length) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (info || size < 8 || bytes[offset + 2] !== 8 || ![1, 3, 4].includes(bytes[offset + 7]) || size !== 8 + bytes[offset + 7] * 3) invalid();
      info = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset = end;
    if (marker === 0xda) {
      if (!info || size < 8) invalid();
      scan = true; const start = offset;
      while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        if (bytes[offset + 1] === 0 || bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7) { offset += 2; continue; }
        break;
      }
      if (offset === start) invalid();
    }
  }
  invalid();
}

function webp(bytes) {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let offset = 12, info, canvas;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size;
    if (end + (size & 1) > bytes.length) invalid();
    const chunk = bytes.subarray(offset + 8, end);
    if (type === "VP8X") {
      if (offset !== 12 || size !== 10 || chunk[0] & 2) invalid();
      canvas = dimensions(chunk.readUIntLE(4, 3) + 1, chunk.readUIntLE(7, 3) + 1);
    } else if (type === "VP8 ") {
      if (info || size < 11 || chunk[0] & 1 || chunk.toString("hex", 3, 6) !== "9d012a") invalid();
      info = dimensions(chunk.readUInt16LE(6) & 0x3fff, chunk.readUInt16LE(8) & 0x3fff);
    } else if (type === "VP8L") {
      if (info || size < 6 || chunk[0] !== 0x2f || chunk[4] & 0xe0) invalid();
      const packed = chunk.readUInt32LE(1);
      info = dimensions((packed & 0x3fff) + 1, (packed >>> 14 & 0x3fff) + 1);
    } else if (!["ALPH", "ICCP", "EXIF", "XMP "].includes(type)) invalid();
    offset = end + (size & 1);
  }
  if (offset !== bytes.length || !info || canvas && (canvas.width !== info.width || canvas.height !== info.height)) invalid();
  return info;
}

export function validateAvatarBytes(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > AVATAR_MAX_BYTES || !AVATAR_MIMES.has(mime)) invalid();
  try { return {mime, ...({"image/png": png, "image/jpeg": jpeg, "image/webp": webp}[mime])(bytes)}; }
  catch (error) { if (error.status) throw error; invalid(); }
}
