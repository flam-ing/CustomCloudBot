const attachmentPath = /^\/api\/rooms\/[a-f0-9-]{36}\/attachments\/[a-f0-9-]{36}$/;

function canceled() { return Object.assign(new Error("내보내기를 취소했습니다."), {name:"AbortError"}); }
export async function loadRoomExport({api, roomId, isCurrent = () => true, signal, onProgress}) {
  let after = 0, through, room;
  const messages = [], seen = new Set();
  do {
    if (!isCurrent() || signal?.aborted) throw canceled();
    const query = through === undefined ? "" : `?after=${after}&through=${through}`;
    const page = await api(`/api/rooms/${encodeURIComponent(roomId)}/export${query}`, {signal});
    if (!isCurrent() || signal?.aborted) throw canceled();
    if (page?.room?.id !== roomId || !Array.isArray(page.messages) || !Number.isSafeInteger(page.through) || page.through < 0 || (through !== undefined && through !== page.through)) throw new Error("대화 기록을 확인하지 못했습니다. 다시 시도해 주세요.");
    room ||= {id:roomId, name:String(page.room.name || "대화")};
    through = page.through;
    for (const item of page.messages) {
      if (!item || typeof item.id !== "string" || seen.has(item.id)) throw new Error("대화 기록이 변경됐습니다. 다시 내려받아 주세요.");
      seen.add(item.id);
      messages.push({id:item.id,kind:String(item.kind || "system"),author:String(item.author || ""),text:String(item.text || ""),createdAt:Number(item.createdAt) || 0,
        attachments:(Array.isArray(item.attachments) ? item.attachments : []).map(file => ({name:String(file.name || "첨부 파일"),mime:String(file.mime || ""),size:Number(file.size) || 0,...(attachmentPath.test(file.url) ? {url:file.url} : {})}))});
    }
    onProgress?.(messages.length);
    if (page.next === null) break;
    if (!Number.isSafeInteger(page.next) || page.next <= after || page.next > through || !page.messages.length) throw new Error("대화 기록을 끝까지 읽지 못했습니다. 다시 시도해 주세요.");
    after = page.next;
  } while (true);
  // Merged histories can carry old timestamps; match the visible chat chronology.
  messages.sort((a,b) => a.createdAt - b.createdAt);
  return {room,messages};
}

export function exportFilename(name, format, now = new Date()) {
  let safe = String(name || "대화").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g," ").replace(/\s+/g," ").trim().replace(/^[. ]+|[. ]+$/g,"").slice(0,80).trim();
  if (!safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = "대화";
  return `${safe}-${now.toISOString().slice(0,10)}.${format === "json" ? "json" : "md"}`;
}
const label = value => String(value).replace(/\s+/g," ").replace(/[\\`*_{}\[\]()#+.!<>|~-]/g,"\\$&");
export function formatRoomExport(data, format, {now = new Date(), origin = ""} = {}) {
  const document = {format:"CustomCloudBot conversation",version:1,exportedAt:now.toISOString(),room:data.room,messages:data.messages};
  if (format === "json") return {text:JSON.stringify(document,null,2)+"\n",mime:"application/json;charset=utf-8",filename:exportFilename(data.room.name,format,now)};
  if (format !== "markdown") throw new Error("지원하지 않는 다운로드 형식입니다.");
  let base = "";
  try { const value = new URL(origin); if (["https:","http:"].includes(value.protocol)) base=value.origin; } catch {}
  const parts = [`# ${label(data.room.name)}`,`내보낸 시각: ${now.toISOString()}`,"첨부 파일은 원본 링크이며, 열려면 이 대화에 접근할 수 있는 계정으로 로그인해야 합니다."];
  for (const item of data.messages) {
    const date = new Date(item.createdAt), at = Number.isNaN(date.getTime()) ? "" : date.toISOString();
    parts.push(`## ${label(item.author || (item.kind === "bot" ? "에이전트" : "안내"))} · ${at}`,item.text);
    for (const file of item.attachments) parts.push(attachmentPath.test(file.url) ? `- [${label(file.name)}](${base}${file.url})` : `- ${label(file.name)}`);
  }
  return {text:parts.join("\n\n")+"\n",mime:"text/markdown;charset=utf-8",filename:exportFilename(data.room.name,format,now)};
}

export function downloadRoomExport(file, {doc = document, urlAPI = URL, timers = globalThis} = {}) {
  const url = urlAPI.createObjectURL(new Blob([file.text], {type:file.mime}));
  const anchor = doc.createElement("a");
  try {
    anchor.href=url; anchor.download=file.filename; anchor.hidden=true; doc.body.append(anchor); anchor.click();
  } catch (error) { urlAPI.revokeObjectURL(url); throw error; }
  finally { anchor.remove(); }
  // Allow the browser to begin reading the blob, including mobile Safari.
  timers.setTimeout(() => urlAPI.revokeObjectURL(url), 60000);
}
