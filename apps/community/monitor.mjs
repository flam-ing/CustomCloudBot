import { readFile } from 'node:fs/promises';
export const MONITOR_ROOM = '00000000-0000-4000-8000-000000000001';
export const MONITOR_STALE_MS = 180000;
const REQUIRED = ['memoryUsedGiB','memoryTotalGiB','diskUsedPercent','diskFreeGiB','communityMemoryGiB','communityLimitGiB','communityCpuLimit','personalLimitGiB','personalCpuLimit'];
const fail = reason => Object.assign(new Error(reason), { reason });

/**
 * Read the collector's snapshot. When it cannot be used the result says why
 * (missing, stale, future, invalid); a stale snapshot is returned as `last`
 * so the dashboard can keep showing the final numbers, clearly marked as old.
 */
export async function readMonitor(path, now = Date.now()) {
  try {
    if (!path) throw fail('missing');
    let raw;
    try { raw = await readFile(path, 'utf8'); } catch (error) { throw fail(error?.code === 'ENOENT' ? 'missing' : 'invalid'); }
    if (raw.length > 16384) throw fail('invalid');
    let s;
    try { s = JSON.parse(raw); } catch { throw fail('invalid'); }
    if (!s || typeof s !== 'object' || !Number.isFinite(s.timestamp)) throw fail('invalid');
    for (const k of REQUIRED) if (!Number.isFinite(s[k]) || s[k] < 0) throw fail('invalid');
    if (s.timestamp > now + 10000) throw fail('future');
    if (now - s.timestamp > MONITOR_STALE_MS) return { available: false, reason: 'stale', last: { ...s } };
    return { ...s, available: true };
  } catch (error) { return { available: false, reason: error?.reason || 'invalid' }; }
}

const decimal = (digits) => new Intl.NumberFormat('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const one = decimal(1), two = decimal(2);
const UNAVAILABLE = {
  missing: '서버 상태를 아직 받지 못했습니다. 상태 수집기가 설치되지 않았거나 상태 파일이 갱신되지 않았습니다.',
  stale: '서버 상태가 3분 넘게 갱신되지 않았습니다. 수집기가 멈췄거나 서버가 응답하지 않을 수 있습니다.',
  invalid: '서버 상태 파일을 읽지 못했습니다. 파일 내용이 올바르지 않습니다.',
  future: '서버 상태의 측정 시각이 현재보다 앞서 있습니다. 서버 시계를 확인해 주세요.',
};

export function explainMonitor(s) {
  if (!s.available) return `${UNAVAILABLE[s.reason] || UNAVAILABLE.missing} 정상 상태나 무료 사용 중이라고 판단할 수 없습니다. 운영자의 수집기 확인이 필요합니다.`;
  return [
    `서버 전체 상태 · ${new Date(s.timestamp).toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})} (한국 시간)`,
    s.scope === 'a1-host' ? `CPU: ${one.format(s.cpuUsedPercent)}% 사용 · 코어 ${s.cpuCount}개` : 'CPU 전체 사용량: 새 수집기 연결 대기',
    `메모리: ${two.format(s.memoryUsedGiB)} / ${two.format(s.memoryTotalGiB)} GiB 사용`,
    s.scope === 'a1-host' ? `저장 공간: ${two.format(s.diskUsedGiB)} / ${two.format(s.diskTotalGiB)} GiB (${one.format(s.diskUsedPercent)}%) 사용` : '저장 공간 전체 사용량: 새 수집기 연결 대기',
    ...(s.scope === 'a1-host' ? [
      `남은 공간: ${two.format(s.diskFreeGiB)} GiB · 아직 파티션에 넣지 않은 공간: ${two.format(s.diskUnallocatedGiB)} GiB`,
      ...s.filesystems.map(f => `${f.mount}: ${two.format(f.usedGiB)} / ${two.format(f.totalGiB)} GiB · 남은 공간 ${two.format(f.freeGiB)} GiB${f.usedPercent >= 85 ? ' — 공간 부족 주의' : ''}`),
    ] : []),
    '이 서비스는 서버의 CPU와 메모리를 운영체제·다른 서비스와 함께 씁니다.',
  ].join('\n');
}
