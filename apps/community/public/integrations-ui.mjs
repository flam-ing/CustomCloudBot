// Connected services: plain-Korean summaries of connection checks (shared by the
// 통합 관리 dialog and the /integrations page) and the 통합 관리 dialog itself.
const count = new Intl.NumberFormat("ko-KR");
const n = (value) => count.format(Number(value) || 0);
const list = (value) => (Array.isArray(value) ? value : []);

/** Button names for each check. Every check only reads; nothing is sent or changed. */
export const CHECK_LABELS = Object.freeze({
  auth: "서버 인증 확인", credits: "남은 크레딧 확인", domains: "등록 도메인 확인", assets: "이미지 목록 확인",
  models: "모델 목록 확인", inbox: "받은 메일 확인", calendars: "캘린더 확인", profile: "계정 확인",
  search: "검색해 보기", voices: "음성 목록 확인", account: "계정 확인",
});
export const checkLabel = (action) => CHECK_LABELS[action] || "연결 확인";

export function serviceStatus(service = {}) {
  return service.configured ? { state: "on", label: "등록됨" } : { state: "off", label: "미등록" };
}

/** Registered services first, then the original order. */
export function sortServices(services = []) {
  return list(services).map((service, index) => ({ service, index }))
    .sort((a, b) => (b.service.configured === true) - (a.service.configured === true) || a.index - b.index)
    .map((item) => item.service);
}

/** One short sentence describing what a successful check found. */
export function summarizeServiceResult(id, action, result) {
  const r = result && typeof result === "object" ? result : {};
  switch (action) {
    case "inbox": {
      const messages = list(r.messages), unread = messages.filter((m) => m && m.read === false).length;
      return `받은 메일 ${n(r.total)}통 · 최근 ${n(messages.length)}통 중 안 읽은 메일 ${n(unread)}통`;
    }
    case "calendars": {
      const own = list(r.calendars).length, shared = list(r.subscribe_calendars).length;
      return shared ? `캘린더 ${n(own)}개 · 구독 캘린더 ${n(shared)}개` : `캘린더 ${n(own)}개`;
    }
    case "profile": {
      if (id === "telegram") return r.ok === false ? "봇 정보를 받지 못했습니다" : `${r.username ? "@" + r.username : "봇"} 확인됨`;
      const who = r.name || r.id || "계정";
      if (r.type === "app") return `${who} 앱 인증 확인됨 · 개인 계정 조회 권한은 없습니다`;
      return `${who} 계정 확인됨`;
    }
    case "search": return `검색 결과 ${n(list(r.results).length)}건`;
    case "voices": return `음성 ${n(list(r.voices).length)}개`;
    case "account": return `${r.username || r.name || "계정"} 계정 확인됨`;
    case "auth": return r.authenticated ? "서버 인증 성공" : "인증 토큰을 받지 못했습니다";
    case "credits": {
      const data = r.data && typeof r.data === "object" ? r.data : r;
      const remaining = data.remainingCredits ?? data.remaining_credits ?? data.credits;
      return Number.isFinite(Number(remaining)) && remaining !== null ? `남은 크레딧 ${n(remaining)}` : "크레딧 정보를 받았습니다";
    }
    case "models": return `모델 ${n(list(r.models).length)}개`;
    case "domains": {
      const domains = list(r.domains), verified = domains.filter((d) => d && d.status === "verified").length;
      return `도메인 ${n(domains.length)}개 · 인증 완료 ${n(verified)}개`;
    }
    case "assets": return `이미지 ${n(list(r.assets).length)}개 (최근 20개까지)`;
    default: return "응답을 받았습니다";
  }
}

/** Summary of /api/models: which providers answered and which failed. */
export function summarizeModelCheck(data = {}) {
  const providers = new Map();
  for (const model of list(data.models)) for (const provider of list(model?.providers)) providers.set(provider, (providers.get(provider) || 0) + 1);
  const failures = list(data.failures);
  const lines = [providers.size ? `공급자 ${n(providers.size)}곳에서 모델 ${n(list(data.models).length)}개를 쓸 수 있습니다.` : "쓸 수 있는 모델이 없습니다."];
  for (const [name, total] of providers) lines.push(`${name} · 모델 ${n(total)}개`);
  if (failures.length) lines.push(`연결하지 못한 공급자 ${n(failures.length)}곳: ${failures.map((f) => (typeof f === "string" ? f : f?.provider || f?.name || "이름 없음")).join(", ")}`);
  return { ok: providers.size > 0 && !failures.length, lines, raw: { providers: Object.fromEntries(providers), failures } };
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(text, className, handler) {
  const element = node("button", className, text);
  element.type = "button";
  if (handler) element.addEventListener("click", handler);
  return element;
}

/** A button disabled while it works drops focus to <body>; give it back afterwards. */
export function keepFocus(element, hadFocus) {
  if (hadFocus && element.isConnected && (!document.activeElement || document.activeElement === document.body || element.closest("dialog") === document.activeElement)) element.focus({ preventScroll: true });
}

/** Run one read-only check and report it in plain words. */
export async function runServiceCheck({ api, service, query = "" }) {
  const action = service.actions[0];
  const body = JSON.stringify(action === "search" ? { query: query || "연결 확인" } : {});
  const data = await api(`/api/admin/integrations/${encodeURIComponent(service.id)}/${encodeURIComponent(action)}`, { method: "POST", body });
  return { text: summarizeServiceResult(service.id, action, data?.result), result: data?.result };
}

/** The 통합 관리 dialog: connected services, AI connections and the conversation reset. */
export async function openCapabilityHub({ api, onReset }) {
  let dialog = document.querySelector("#capability-hub");
  if (!dialog) {
    dialog = node("dialog", "capability-hub"); dialog.id = "capability-hub";
    dialog.setAttribute("aria-labelledby", "capability-hub-title");
    // Return focus to whatever opened the dialog, or to the visible menu button when that was a menu item.
    dialog.addEventListener("close", () => {
      // Esc also closes the phone drawer, which hides only after its slide-out, so skip anything inside a closing drawer.
      const inClosedDrawer = (element) => !!element.closest(".sidebar:not(.is-open)") && !!globalThis.matchMedia?.("(max-width: 720px)").matches;
      const visible = (element) => element?.isConnected && element.checkVisibility?.({ visibilityProperty: true }) !== false && !inClosedDrawer(element);
      const target = [dialog.returnTarget, document.querySelector("#profile-customize"), document.querySelector("#mobile-menu")].find(visible);
      dialog.returnTarget = null; target?.focus({ preventScroll: true });
    });
    document.body.append(dialog);
  }
  const opener = document.activeElement;
  dialog.returnTarget = opener instanceof HTMLElement && opener !== document.body && !opener.closest("#profile-menu") ? opener : null;
  const generation = (dialog.generation = (dialog.generation || 0) + 1);
  dialog.replaceChildren();

  const head = node("header", "hub-head"), title = node("h2", "", "통합 관리"); title.id = "capability-hub-title";
  const close = button("", "icon-button hub-close", () => dialog.close()); close.setAttribute("aria-label", "통합 관리 닫기");
  close.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-close" /></svg>';
  head.append(title, close);

  const services = node("section", "hub-section"), servicesHead = node("div", "hub-section-head");
  const link = node("a", "hub-link", "연결 서비스 화면 열기"); link.href = "/integrations";
  servicesHead.append(node("h3", "", "연결 서비스"), link);
  const servicesNote = node("p", "hub-note", "연결 목록을 불러오는 중…");
  const serviceList = node("ul", "hub-services");
  services.append(servicesHead, servicesNote, serviceList);

  const ai = node("section", "hub-section"); ai.append(node("h3", "", "AI 모델 연결"));
  const aiList = node("div", "hub-chips"); ai.append(aiList);
  const tools = node("section", "hub-section"); tools.append(node("h3", "", "MCP 서버 · 스킬"));
  const toolsNote = node("p", "hub-note", "확인하는 중…"); tools.append(toolsNote);

  const sessions = node("section", "hub-section hub-reset");
  const reset = button("대화 목록 초기화", "hub-reset-button", () => void onReset?.(reset, dialog));
  sessions.append(node("h3", "", "대화 목록 초기화"), node("p", "hub-note", "내 대화 목록을 비우고 새 줄기에서 시작합니다. 이전 대화는 ‘대화 복원’에서 되살릴 수 있습니다."), reset);

  dialog.append(head, services, ai, tools, sessions, node("p", "hub-foot", "키 값은 서버 저장소에 보관되며 이 화면에는 표시되지 않습니다."));
  if (!dialog.open) dialog.showModal();
  close.focus({ preventScroll: true });

  try {
    const data = await api("/api/admin/capabilities");
    if (dialog.generation !== generation || !dialog.open) return;
    const all = sortServices(data.services);
    const registered = all.filter((service) => service.configured).length;
    servicesNote.textContent = `${n(all.length)}개 중 ${n(registered)}개 등록됨 · ‘연결 확인’은 실제로 로그인되는지 읽기만 해서 검사합니다.`;
    for (const service of all) {
      const status = serviceStatus(service), item = node("li", "hub-service"), main = node("div", "hub-service-main");
      const chip = node("span", "hub-chip", status.label); chip.dataset.state = status.state;
      main.append(node("strong", "hub-service-name", service.name), chip);
      item.append(main);
      if (service.configured && Array.isArray(service.actions) && service.actions.length) {
        const result = node("p", "hub-result"); result.setAttribute("aria-live", "polite");
        const check = button("연결 확인", "hub-check", async () => {
          const hadFocus = document.activeElement === check;
          check.disabled = true; check.textContent = "확인 중…"; result.dataset.state = "busy"; result.textContent = "연결을 확인하고 있어요…";
          try { const outcome = await runServiceCheck({ api, service }); result.dataset.state = "ok"; result.textContent = "연결됨 · " + outcome.text; }
          catch (error) { result.dataset.state = "error"; result.textContent = error.message || "연결하지 못했습니다."; }
          finally { check.disabled = false; check.textContent = "연결 확인"; keepFocus(check, hadFocus); }
        });
        check.setAttribute("aria-label", `${service.name} 연결 확인`);
        item.append(check, result);
      }
      serviceList.append(item);
    }
    const providers = [...new Set(list(data.providers).map((provider) => provider?.name).filter(Boolean))];
    aiList.replaceChildren(...(providers.length ? providers.map((name) => node("span", "hub-chip", name)) : [node("p", "hub-note", "연결된 AI 모델이 없습니다. ‘내 봇 설정’에서 연결하세요.")]));
    const mcp = list(data.mcp).length, skills = list(data.skills).length;
    toolsNote.textContent = mcp || skills ? `MCP 서버 ${n(mcp)}개 · 스킬 ${n(skills)}개가 연결되어 있습니다.` : "연결된 MCP 서버와 실행할 수 있는 스킬이 아직 없습니다.";
  } catch (error) {
    if (dialog.generation !== generation) return;
    servicesNote.textContent = error.message || "연결 목록을 불러오지 못했습니다.";
    servicesNote.dataset.state = "error";
    aiList.replaceChildren(); toolsNote.textContent = "";
  }
}
