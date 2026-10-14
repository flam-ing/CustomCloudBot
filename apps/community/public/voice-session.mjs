// A call stays bound to one authenticated conversation, regardless of navigation.
export function callReply(data, messageId) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const index = messages.findIndex(message => message.id === messageId && message.kind === "human");
  if (index < 0) return {state: "waiting"};
  for (const message of messages.slice(index + 1)) {
    if (message.kind === "human") return {state: "interrupted"};
    if (message.kind === "bot" && message.text?.trim()) return {state: "reply", text: message.text};
    if (message.kind === "system" && message.text?.trim()) return {state: "error", text: message.text};
  }
  return {state: data.busy ? "waiting" : "empty"};
}

export function speechText(value) {
  const clean = String(value || "")
    .replace(/```[\s\S]*?```/g, " 코드 내용은 대화에 남겨두었어요. ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "링크")
    .replace(/[#*_`>|]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 1200 ? clean.slice(0, 1200) + " 나머지는 대화에서 확인해 주세요." : clean;
}

export function callLink(origin, roomId) {
  const url = new URL("/", origin);
  url.searchParams.set("room", roomId);
  url.searchParams.set("call", "1");
  return url.href;
}

export function createSpeechGate({threshold = 0.018, silenceMs = 1100, maxMs = 30000} = {}) {
  let startedAt, voiceAt, frames = 0, voiced = false;
  return {
    sample(rms, now) {
      startedAt ??= now;
      if (rms >= threshold) { frames++; if (frames >= 3) { voiced = true; voiceAt = now; } }
      else frames = 0;
      if (voiced && (now - voiceAt >= silenceMs || now - startedAt >= maxMs)) return "send";
      if (!voiced && now - startedAt >= maxMs) return "discard";
      return "listen";
    },
    get voiced() { return voiced; },
  };
}
