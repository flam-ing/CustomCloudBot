// Server dashboard: pure helpers (tested in node) and the DOM renderer used by app.js.
const oneDecimal = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const wholeNumber = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const finite = (value) => typeof value === "number" && Number.isFinite(value);

export const formatGiB = (value) => (finite(value) ? `${oneDecimal.format(value)} GiB` : "—");
export const formatPercent = (value) => (finite(value) ? `${oneDecimal.format(value)}%` : "—");
export const formatCount = (value) => (finite(value) ? wholeNumber.format(value) : "—");

/** 70% and above needs attention, 90% and above is close to full. */
export function usageLevel(percent) {
  if (!finite(percent)) return "unknown";
  return percent >= 90 ? "danger" : percent >= 70 ? "warning" : "ok";
}
/** A single filesystem is only flagged once it is nearly full. */
export function filesystemLevel(percent) {
  if (!finite(percent)) return "unknown";
  return percent >= 95 ? "danger" : percent >= 85 ? "warning" : "ok";
}
export const LEVEL_LABELS = Object.freeze({ warning: "주의", danger: "위험" });

export function hostMetrics(snapshot = {}) {
  const memoryPercent = finite(snapshot.memoryUsedGiB) && snapshot.memoryTotalGiB > 0 ? (snapshot.memoryUsedGiB / snapshot.memoryTotalGiB) * 100 : NaN;
  return [
    { id: "cpu", label: "CPU", value: formatPercent(snapshot.cpuUsedPercent), detail: finite(snapshot.cpuCount) ? `코어 ${formatCount(snapshot.cpuCount)}개 전체 기준` : "전체 코어 기준", percent: snapshot.cpuUsedPercent },
    { id: "memory", label: "메모리", value: formatGiB(snapshot.memoryUsedGiB), detail: `전체 ${formatGiB(snapshot.memoryTotalGiB)} 중 ${formatPercent(memoryPercent)} 사용`, percent: memoryPercent },
    { id: "disk", label: "저장 공간", value: formatPercent(snapshot.diskUsedPercent), detail: `${formatGiB(snapshot.diskTotalGiB)} 중 ${formatGiB(snapshot.diskUsedGiB)} 사용`, percent: snapshot.diskUsedPercent },
  ]
    .filter((metric) => finite(metric.percent))
    .map((metric) => ({ ...metric, level: usageLevel(metric.percent) }));
}

/** Items that need attention, most serious first. */
export function hostAlerts(snapshot = {}) {
  const alerts = hostMetrics(snapshot)
    .filter((metric) => metric.level === "warning" || metric.level === "danger")
    .map((metric) => ({ id: metric.id, level: metric.level, text: `${metric.label} ${formatPercent(metric.percent)}` }));
  for (const fs of Array.isArray(snapshot.filesystems) ? snapshot.filesystems : []) {
    const level = filesystemLevel(fs?.usedPercent);
    if (level === "warning" || level === "danger") alerts.push({ id: "fs:" + fs.mount, level, text: `${mountLabel(fs.mount)} 남은 공간 ${formatGiB(fs.freeGiB)}` });
  }
  return alerts.sort((a, b) => (b.level === "danger") - (a.level === "danger"));
}

export function mountLabel(mount) {
  return mount === "/" ? "시스템 디스크(/)" : String(mount || "디스크");
}

const minutesSince = (timestamp, now) => (finite(timestamp) ? Math.max(1, Math.round((now - timestamp) / 60000)) : null);

/**
 * Why the dashboard cannot show live numbers, in words an operator can act on.
 * Returns null while live data is arriving.
 */
export function monitorProblem(snapshot = {}, { now = Date.now(), lastTimestamp } = {}) {
  if (snapshot.available && snapshot.scope === "a1-host") return null;
  if (snapshot.available) return { reason: "old-collector", title: "수집기가 예전 버전입니다", text: "CPU와 저장 공간 전체 사용량을 받으려면 서버의 상태 수집기를 새 버전으로 바꿔 주세요." };
  const minutes = minutesSince(snapshot.last?.timestamp ?? lastTimestamp, now);
  switch (snapshot.reason) {
    case "missing":
      return { reason: "missing", title: "서버 상태를 아직 받지 못했습니다", text: "상태를 모으는 수집기가 설치되지 않았거나 아직 한 번도 실행되지 않았습니다. 서버에서 수집기를 확인해 주세요." };
    case "stale":
      return { reason: "stale", title: minutes ? `서버 상태가 ${formatCount(minutes)}분째 갱신되지 않았습니다` : "서버 상태가 갱신되지 않았습니다", text: "수집기가 멈췄거나 서버가 응답하지 않을 수 있습니다. 아래 숫자는 마지막으로 받은 값입니다." };
    case "invalid":
      return { reason: "invalid", title: "서버 상태 파일을 읽지 못했습니다", text: "파일 내용이 올바르지 않습니다. 수집기를 다시 실행하거나 새 버전으로 바꿔 주세요." };
    case "future":
      return { reason: "future", title: "측정 시각이 현재보다 앞서 있습니다", text: "서버 시계가 맞지 않는 것 같습니다. 서버 시간을 확인해 주세요." };
    case "network":
      return { reason: "network", title: "앱 서버에 연결하지 못했습니다", text: "인터넷 연결이나 앱 서버 상태를 확인해 주세요. 3초마다 다시 시도합니다." };
    default:
      return { reason: "unknown", title: "최신 서버 상태를 받지 못했습니다", text: "잠시 후 자동으로 다시 확인합니다." };
  }
}

/** The numbers to show: live data, or the last good snapshot (shown dimmed). */
export function dashboardData(snapshot = {}, last = null) {
  if (snapshot.available && snapshot.scope === "a1-host") return { data: snapshot, live: true };
  const fallback = snapshot.last?.scope === "a1-host" ? snapshot.last : last;
  if (fallback) return { data: fallback, live: false };
  if (snapshot.available) return { data: snapshot, live: true };
  return { data: null, live: false };
}

function element(doc, tag, text, className) {
  const node = doc.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function chip(doc, level) {
  const label = LEVEL_LABELS[level];
  return label ? element(doc, "span", label, "host-chip") : null;
}
function meter(doc, percent, label, level) {
  const bar = doc.createElement("progress");
  bar.max = 100;
  bar.value = Math.min(100, Math.max(0, percent));
  bar.dataset.level = level;
  bar.setAttribute("aria-label", `${label} 사용률 ${formatPercent(percent)}`);
  return bar;
}
const timeLabel = (timestamp) =>
  new Date(timestamp).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Build the dashboard. `last` is the most recent live snapshot this page has seen. */
export function renderHostDashboard(snapshot = {}, { last = null, now = Date.now(), doc = globalThis.document } = {}) {
  const problem = monitorProblem(snapshot, { now, lastTimestamp: last?.timestamp });
  const { data, live } = dashboardData(snapshot, last);
  const panel = element(doc, "section", null, "host-dashboard");
  panel.classList.toggle("is-stale", !!data && !live);
  const head = element(doc, "header", null, "host-head");
  head.append(element(doc, "h2", "서버 대시보드"), element(doc, "p", "이 앱이 돌아가는 서버 전체의 사용량입니다.", "host-subtitle"));
  panel.append(head);

  const banner = element(doc, "div", null, "host-banner");
  if (problem) {
    banner.dataset.level = problem.reason === "old-collector" ? "warning" : "offline";
    banner.append(element(doc, "strong", problem.title), element(doc, "span", problem.text));
  } else {
    const alerts = hostAlerts(data);
    banner.dataset.level = alerts.some((alert) => alert.level === "danger") ? "danger" : alerts.length ? "warning" : "ok";
    if (alerts.length) banner.append(element(doc, "strong", `주의 ${formatCount(alerts.length)}건`), element(doc, "span", alerts.map((alert) => alert.text).join(" · ")));
    else banner.append(element(doc, "strong", "정상"), element(doc, "span", "주의할 항목이 없습니다."));
  }
  panel.append(banner);
  if (!data) return panel;

  const metrics = hostMetrics(data);
  if (metrics.length) {
    const cards = element(doc, "div", null, "host-cards");
    for (const metric of metrics) {
      const card = element(doc, "article", null, "host-card");
      card.dataset.level = metric.level;
      const title = element(doc, "div", null, "host-card-head");
      title.append(element(doc, "h3", metric.label));
      const levelChip = chip(doc, metric.level);
      if (levelChip) title.append(levelChip);
      card.append(title, element(doc, "strong", metric.value, "host-value"), element(doc, "p", metric.detail), meter(doc, metric.percent, metric.label, metric.level));
      cards.append(card);
    }
    panel.append(cards);
  }
  const filesystems = Array.isArray(data.filesystems) ? data.filesystems.filter((fs) => fs && finite(fs.totalGiB)) : [];
  if (filesystems.length || finite(data.diskFreeGiB)) {
    const storage = element(doc, "section", null, "host-storage");
    storage.append(element(doc, "h3", "디스크별 공간"));
    if (finite(data.diskFreeGiB)) storage.append(element(doc, "p", `지금 쓸 수 있는 남은 공간은 모두 ${formatGiB(data.diskFreeGiB)}입니다.`, "host-storage-summary"));
    if (data.diskUnallocatedGiB > 1) storage.append(element(doc, "p", `아직 파티션에 넣지 않은 ${formatGiB(data.diskUnallocatedGiB)}는 파티션을 늘려야 쓸 수 있습니다.`, "host-subtitle"));
    for (const fs of filesystems) {
      const level = filesystemLevel(fs.usedPercent);
      const row = element(doc, "div", null, "host-filesystem");
      row.dataset.level = level;
      const name = element(doc, "div", null, "host-filesystem-name");
      name.append(element(doc, "strong", mountLabel(fs.mount)));
      const levelChip = chip(doc, level);
      if (levelChip) { levelChip.textContent = "공간 부족"; name.append(levelChip); }
      row.append(name, element(doc, "span", `${formatGiB(fs.usedGiB)} / ${formatGiB(fs.totalGiB)} 사용 · 남은 공간 ${formatGiB(fs.freeGiB)}`, "host-filesystem-detail"));
      if (finite(fs.usedPercent)) row.append(meter(doc, fs.usedPercent, mountLabel(fs.mount), level));
      storage.append(row);
    }
    panel.append(storage);
  }
  if (finite(data.timestamp)) {
    const ago = live ? "" : ` (${formatCount(minutesSince(data.timestamp, now))}분 전)`;
    panel.append(element(doc, "p", `마지막 측정 ${timeLabel(data.timestamp)}${ago}${live ? " · 3초마다 새로 확인합니다" : ""}`, "host-updated"));
  }
  return panel;
}
