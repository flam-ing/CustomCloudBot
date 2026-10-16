const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/mp4", "video/mp4"]);
const mimeOf = file => String(file.type || "").toLowerCase().split(";", 1)[0];
const kindOf = file => IMAGE_TYPES.has(mimeOf(file)) ? "image" : AUDIO_TYPES.has(mimeOf(file)) ? "audio" : null;
let uploadTail = Promise.resolve();
function scheduleUpload(task) {
  // The server's per-user upload limit is shared across split composers.
  const pending = uploadTail.then(task);
  uploadTail = pending.catch(() => {});
  return pending;
}

// Read only the user-triggered paste event, never the ambient clipboard.
export function clipboardImageFiles(event) {
  const data = event.clipboardData;
  if (!data) return [];
  const items = [...(data.items || [])].filter(item => item.kind === "file" && /^image\//i.test(item.type || ""));
  const files = items.map(item => item.getAsFile?.()).filter(Boolean);
  return files.length ? files : [...(data.files || [])].filter(file => /^image\//i.test(file.type || ""));
}

export function pasteComposerImages(event, { enabled, upload }) {
  if (!enabled) return false;
  const files = clipboardImageFiles(event);
  if (!files.length) return false;
  event.preventDefault();
  void upload(files);
  return true;
}

export function removeAttachmentDraft(owner, item, revoke = url => URL.revokeObjectURL(url)) {
  const index = owner.pendingAttachments?.indexOf(item) ?? -1;
  if (index < 0) return;
  owner.pendingAttachments.splice(index, 1);
  item.controller?.abort();
  if (item.previewUrl) revoke(item.previewUrl);
}

export function clearAttachmentDraft(owner, revoke = url => URL.revokeObjectURL(url)) {
  owner.attachmentGeneration = (owner.attachmentGeneration || 0) + 1;
  for (const item of [...(owner.pendingAttachments || [])]) removeAttachmentDraft(owner, item, revoke);
  owner.pendingAttachments = [];
}

export async function uploadAttachmentFiles({ files, owner, roomId, isCurrent, upload, changed, notify, signal,
  createPreview = file => URL.createObjectURL(file), revokePreview = url => URL.revokeObjectURL(url) }) {
  if (!roomId || !isCurrent() || signal?.aborted) return;
  owner.pendingAttachments ||= [];
  const generation = owner.attachmentGeneration || 0;
  const current = () => !signal?.aborted && isCurrent() && (owner.attachmentGeneration || 0) === generation;
  const accepted = [];
  for (const file of Array.from(files || [])) {
    if (!kindOf(file)) { notify("PNG, JPEG, WebP, GIF 사진 또는 지원되는 음성 파일만 첨부할 수 있어요."); continue; }
    if (!file.size || file.size > 12 * 1024 * 1024) { notify(`${file.name || "사진"}: 파일은 12MB 이하의 빈 파일이 아니어야 해요.`); continue; }
    accepted.push(file);
  }
  if (owner.pendingAttachments.length + accepted.length > 4) {
    notify("메시지 하나에 최대 4개까지 첨부할 수 있어요.");
    return;
  }
  // Reserve the entire batch before awaiting so simultaneous pastes share the limit.
  const batch = accepted.map(file => {
    const kind = kindOf(file);
    const name = file.name || (kind === "image" ? `screenshot-${Date.now()}.${mimeOf(file).split("/")[1]}` : "audio");
    const item = { roomId, name, kind, previewUrl: createPreview(file), uploading: true, attachment: null, controller: new AbortController() };
    owner.pendingAttachments.push(item);
    return { file, item };
  });
  // A recorder's cancel signal owns only this batch. Do not invalidate another
  // screenshot/audio draft already in the same composer or its upload generation.
  const cancelBatch = () => {
    let removed = false;
    for (const { item } of batch) if (owner.pendingAttachments.includes(item)) {
      removeAttachmentDraft(owner, item, revokePreview); removed = true;
    }
    if (removed && isCurrent() && (owner.attachmentGeneration || 0) === generation) changed();
  };
  signal?.addEventListener("abort", cancelBatch, { once: true });
  if (signal?.aborted) cancelBatch();
  else if (batch.length) changed();
  try {
    await Promise.all(batch.map(async ({ file, item }) => {
      const belongs = () => current() && owner.pendingAttachments.includes(item);
      try {
        if (!belongs()) return;
        const data = await scheduleUpload(() => belongs() ? upload(file, item.name, item.controller.signal) : null);
        if (!belongs()) return;
        if (!data?.attachment?.id) throw new Error("첨부 파일을 확인하지 못했습니다. 다시 첨부해 주세요.");
        item.attachment = data.attachment;
        item.name = data.attachment.name || item.name;
      } catch (error) {
        if (!belongs()) return;
        item.error = error.message || "업로드하지 못했습니다.";
      } finally {
        if (belongs()) { item.uploading = false; changed(); }
      }
    }));
  } finally { signal?.removeEventListener("abort", cancelBatch); }
}
