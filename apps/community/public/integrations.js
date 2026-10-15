import { applyBrand } from "/setup.js";
import { checkLabel, serviceStatus, sortServices, summarizeServiceResult, summarizeModelCheck } from "/integrations-ui.mjs";
const status = document.querySelector("#status"), services = document.querySelector("#services");
let csrf;
const names = new Map();
async function api(path, body) {
  const r = await fetch(path, { cache: "no-store", ...(body ? { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) } : {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || "연결하지 못했습니다.");
  return d;
}
const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
const count = new Intl.NumberFormat("ko-KR");
const SERVICE_NOTES = { "관리자 전용 조회": "관리자만 읽기 전용으로 조회합니다.", "키 보관 · 실행 어댑터 미연결": "키만 보관하고 있으며 아직 조회 기능은 없습니다." };

/** Plain summary first; the raw response stays folded for anyone who needs it. */
function showResult(target, { state, lines, raw }) {
  target.replaceChildren();
  const summary = node("div", "integ-summary"); summary.dataset.state = state;
  for (const line of lines) summary.append(node("p", "", line));
  target.append(summary);
  if (raw !== undefined) {
    const details = node("details", "integ-raw"), toggle = node("summary", "", "원문 보기"), pre = node("pre");
    pre.textContent = JSON.stringify(raw, null, 2); details.append(toggle, pre); target.append(details);
  }
}

try {
  const session = await api("/api/session"); applyBrand(session.brand);
  if (session.user?.role !== "admin") throw Error("사이트 관리자로 로그인해야 볼 수 있습니다.");
  csrf = session.csrfToken;
  const rooms = await api("/api/rooms");
  const personal = rooms.rooms.find((r) => r.personal); if (personal) document.querySelector("#personal-chat").href = "/?room=" + encodeURIComponent(personal.id);
  const data = await api("/api/admin/integrations");
  for (const service of data.services) names.set(service.id, service.name);
  for (const service of sortServices(data.services)) {
    const state = serviceStatus(service);
    const article = node("article", "integ-card integ-service"); article.dataset.state = state.state;
    const head = node("div", "integ-service-head"), chip = node("span", "integ-chip", state.label); chip.dataset.state = state.state;
    head.append(node("h3", "", service.name), chip);
    article.append(head, node("p", "integ-note", service.configured ? SERVICE_NOTES[service.note] || service.note : "키를 등록하면 연결을 확인할 수 있습니다."));
    const result = node("div", "integ-result"); result.setAttribute("aria-live", "polite");
    const controls = node("div", "integ-controls");
    let query;
    if (service.actions.includes("search")) { query = node("input", "integ-input"); query.placeholder = "검색어"; query.setAttribute("aria-label", `${service.name} 검색어`); query.disabled = !service.configured; controls.append(query); }
    for (const action of service.actions) {
      const button = node("button", "integ-button", checkLabel(action)); button.type = "button"; button.disabled = !service.configured;
      button.onclick = async () => {
        button.disabled = true; showResult(result, { state: "busy", lines: ["확인하고 있어요…"] });
        try {
          const response = await api(`/api/admin/integrations/${service.id}/${action}`, query ? { query: query.value } : {});
          showResult(result, { state: "ok", lines: ["연결됨 · " + summarizeServiceResult(service.id, action, response.result)], raw: response.result });
        } catch (e) { showResult(result, { state: "error", lines: [e.message] }); }
        finally { button.disabled = false; }
      };
      controls.append(button);
    }
    article.append(controls, result); services.append(article);
  }
  const registered = data.services.filter((s) => s.configured).length;
  status.textContent = `${count.format(data.services.length)}개 중 ${count.format(registered)}개 등록됨 · 확인 버튼은 실제로 로그인되는지 읽기만 해서 검사합니다.`;
} catch (e) { status.textContent = e.message; status.dataset.state = "error"; }

document.querySelector("#models").onclick = async (event) => {
  const output = document.querySelector("#model-result"), button = event.currentTarget;
  button.disabled = true; showResult(output, { state: "busy", lines: ["확인하고 있어요…"] });
  try { const summary = summarizeModelCheck(await api("/api/models")); showResult(output, { state: summary.ok ? "ok" : "error", lines: summary.lines, raw: summary.raw }); }
  catch (e) { showResult(output, { state: "error", lines: [e.message] }); }
  finally { button.disabled = false; }
};

document.querySelector("#ask-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = document.querySelector("#ask-button"), output = document.querySelector("#answer");
  button.disabled = true; output.replaceChildren(node("p", "integ-note", "연결 서비스를 확인하고 있어요…"));
  try {
    const data = await api("/api/admin/integrations/ask", { prompt: document.querySelector("#ask-prompt").value });
    output.replaceChildren(node("p", "integ-answer-text", data.answer));
    if (data.usedServices?.length) output.append(node("p", "integ-note", "조회한 서비스: " + data.usedServices.map((s) => `${names.get(s.id) || s.id} (${checkLabel(s.action)})`).join(", ")));
  } catch (e) { output.replaceChildren(node("p", "integ-error", e.message)); }
  finally { button.disabled = false; }
};
