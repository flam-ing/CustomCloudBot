import { readProviders } from './providers.mjs';

export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 30;
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_RESPONSE_BYTES = 64 * 1024;
const AUDIO_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'video/mp4']);
const fail = (status, message) => Object.assign(new Error(message), { status });

async function boundedJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw fail(502, '음성 인식 응답이 너무 큽니다. 짧게 다시 말씀해 주세요.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw fail(502, '음성 인식 결과를 받지 못했습니다.');
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw fail(502, '음성 인식 응답이 너무 큽니다. 짧게 다시 말씀해 주세요.');
      }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail(502, '음성 인식 결과를 읽지 못했습니다. 다시 말씀해 주세요.'); }
  } finally { reader.releaseLock(); }
}

/** Transcribes only. Chat submission and all tool permissions remain in /messages. */
export function createVoiceTranscriber({ getEnv = () => ({}), fetchImpl = fetch } = {}) {
  let cursor = 0;
  const candidates = () => readProviders(getEnv()).filter(provider =>
    provider.name === 'groq' && provider.baseUrl === 'https://api.groq.com/openai/v1');
  return {
    status() {
      const configured = candidates().length > 0;
      return { configured, provider: configured ? 'groq' : null, maxSeconds: VOICE_MAX_SECONDS, maxBytes: VOICE_MAX_BYTES };
    },
    async transcribe({ bytes, mime, signal }) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > VOICE_MAX_BYTES)
        throw fail(413, '음성은 10 MiB 이내로 보내 주세요.');
      if (!AUDIO_TYPES.has(mime)) throw fail(415, '지원하지 않는 음성 형식입니다.');
      const providers = candidates();
      if (!providers.length) throw fail(503, '음성 통화에는 Groq API 연결이 필요합니다. 설정에서 연결해 주세요.');
      const start = cursor++ % providers.length;
      const ordered = [...providers.slice(start), ...providers.slice(0, start)].slice(0, 3);
      const deadline = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
      const extension = ({ 'audio/webm':'webm', 'audio/ogg':'ogg', 'audio/wav':'wav', 'audio/x-wav':'wav', 'audio/mpeg':'mp3', 'audio/mp3':'mp3', 'audio/mp4':'mp4', 'video/mp4':'mp4' })[mime];
      let lastStatus = 503;
      for (const provider of ordered) {
        if (deadline.aborted) throw fail(408, '음성 인식 시간이 초과되었거나 통화가 종료되었습니다.');
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: mime }), 'speech.' + extension);
        form.append('model', 'whisper-large-v3-turbo');
        form.append('response_format', 'verbose_json');
        form.append('temperature', '0');
        let response;
        try {
          response = await fetchImpl(ENDPOINT, {
            method: 'POST', redirect: 'error', signal: deadline,
            headers: { authorization: 'Bearer ' + provider.apiKey }, body: form,
          });
        } catch {
          if (deadline.aborted) throw fail(408, '음성 인식 시간이 초과되었거나 통화가 종료되었습니다.');
          throw fail(502, '음성 인식에 연결하지 못했습니다. 다시 말씀해 주세요.');
        }
        if (!response.ok) {
          lastStatus = response.status;
          await response.body?.cancel();
          if ([401, 403, 429].includes(lastStatus) || lastStatus >= 500) continue;
          throw fail(502, '음성을 인식하지 못했습니다. 짧게 다시 말씀해 주세요.');
        }
        let data;
        try { data = await boundedJson(response); }
        catch (error) {
          if (deadline.aborted) throw fail(408, '음성 인식 시간이 초과되었거나 통화가 종료되었습니다.');
          throw error;
        }
        if (typeof data?.duration === 'number' && (!Number.isFinite(data.duration) || data.duration > VOICE_MAX_SECONDS + 1))
          throw fail(413, '한 번에 30초 이내로 말씀해 주세요.');
        if (typeof data?.text !== 'string' || data.text.length > 4000)
          throw fail(502, '음성 인식 결과가 올바르지 않습니다. 짧게 다시 말씀해 주세요.');
        return { text: data.text.trim() };
      }
      throw fail(lastStatus === 429 ? 429 : 503,
        lastStatus === 429 ? '음성 인식 사용량이 잠시 초과되었습니다. 잠시 후 다시 말씀해 주세요.' : '음성 인식 연결을 확인해 주세요.');
    },
  };
}
