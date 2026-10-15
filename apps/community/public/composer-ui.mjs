// Pure helpers for the chat composer: labels, timing and popover placement.
// They take plain values so the browser code stays small and node:test can cover them.

export const EFFORTS = Object.freeze([
  ["", "기본"],
  ["low", "낮게"],
  ["medium", "보통"],
  ["high", "높게"],
  ["xhigh", "최대"],
]);

export const RECORDING_LIMIT_MS = 120000;
export const RECORDING_WARN_MS = 110000;
export const ATTACHMENT_LIMIT = 4;

export function effortLabel(value) {
  return (EFFORTS.find(([key]) => key === (value || "")) || EFFORTS[0])[1];
}

// The chip shows the model and, when it is not the default, the thinking depth.
export function modelChipLabel(modelText, effort) {
  const name = String(modelText || "").replace(/\s*[·•]\s*(추천|선택됨)\s*$/u, "").trim() || "자동 선택";
  return effort && EFFORTS.some(([key]) => key === effort) ? `${name} · ${effortLabel(effort)}` : name;
}

export function botChipLabel(selectedIds, bots) {
  const names = (selectedIds || []).map((id) => (bots || []).find((bot) => bot.id === id)?.name).filter(Boolean);
  if (!names.length) return "봇 없음";
  return names.length === 1 ? names[0] : `${names[0]} 외 ${names.length - 1}`;
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Long notices stay a little longer; nothing lingers past seven seconds.
export function toastDuration(text) {
  return Math.min(7000, 2600 + String(text || "").length * 45);
}

// Desktop: Enter sends and Shift+Enter breaks the line.
// Touch keyboards: Enter always breaks the line; the send button sends.
// A hardware keyboard on a tablet can still send with Ctrl/Cmd+Enter.
export function sendsOnEnter(event, { touch = false } = {}) {
  if (!event || event.key !== "Enter" || event.isComposing || event.keyCode === 229) return false;
  if (event.shiftKey || event.altKey) return false;
  if (touch) return !!(event.metaKey || event.ctrlKey);
  return true;
}

// Places a popup next to its trigger inside the visible area. Prefers the side
// with room (above by default, since the composer sits at the bottom) and caps
// the height so the popup never covers the row that holds the trigger.
export function placePopover(anchor, size, viewport, { align = "start", gap = 8, margin = 12, prefer = "above" } = {}) {
  const view = { left: viewport.left || 0, top: viewport.top || 0, width: viewport.width, height: viewport.height };
  const width = Math.max(0, Math.min(size.width, view.width - margin * 2));
  const minLeft = view.left + margin, maxLeft = view.left + view.width - margin - width;
  const wanted = align === "end" ? anchor.right - width : align === "center" ? (anchor.left + anchor.right - width) / 2 : anchor.left;
  const left = Math.round(Math.max(minLeft, Math.min(maxLeft, wanted)));
  const above = Math.max(0, anchor.top - gap - (view.top + margin));
  const below = Math.max(0, view.top + view.height - margin - (anchor.bottom + gap));
  const fitsAbove = size.height <= above, fitsBelow = size.height <= below;
  const placement = prefer === "below"
    ? (fitsBelow || below >= above ? "below" : "above")
    : (fitsAbove || above >= below ? "above" : "below");
  const maxHeight = Math.floor(placement === "above" ? above : below);
  const height = Math.min(size.height, maxHeight);
  const top = Math.round(placement === "above" ? anchor.top - gap - height : anchor.bottom + gap);
  return { left, top, width, maxHeight, placement };
}

// Korean topic particle for a name: "회의방" → "은", "메모" → "는", "Plan" → "은(는)".
export function topicParticle(word) {
  const text = String(word || "").trim();
  const code = text.charCodeAt(text.length - 1) - 0xac00;
  if (!(code >= 0 && code <= 11171)) return "은(는)";
  return code % 28 ? "은" : "는";
}
