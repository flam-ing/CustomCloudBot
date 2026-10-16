import { BROWSER_TOOL_DEFINITIONS } from './browser-tools.mjs';
import { normalizeBotOutput } from './model-output.mjs';
import { usageEvent } from './usage.mjs';

const MAX_ATTEMPTS_PER_STEP = 8;
const MAX_CALLS = 32;
const RETRYABLE_STATUS = new Set([400,401,402,403,404,408,429,500,502,503,504]);
const safeName = value => typeof value === 'string' && /^[\w.:/@+ -]{1,200}$/.test(value) ? value : 'unknown';
const endpointFor = baseUrl => {
  const endpoint = new URL(String(baseUrl).replace(/\/+$/, '') + '/chat/completions');
  if(endpoint.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)) throw new Error('Model endpoint must use HTTPS');
  return endpoint;
};
const responseError = (reason, message) => Object.assign(new Error(message), { responseReason: reason });
const httpReason = status => status === 429 ? 'rate_limit' : [401,402,403].includes(status) ? 'authentication' : status === 408 ? 'timeout' : status === 400 ? 'invalid_response' : 'unavailable';

// Hooks and body reads must still stop promptly if a caller neglects the signal.
function withSignal(promise, signal) {
  if(!signal) return promise;
  return new Promise((resolve,reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, {once:true});
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if(signal.aborted) abort();
  });
}

async function readPayload(response, signal) {
  if(!response.body) throw responseError('empty_response', 'Empty model response');
  const reader=response.body.getReader(), chunks=[];
  let bytes=0;
  try {
    for(;;) {
      const result=await withSignal(reader.read(), signal);
      if(result.done) break;
      bytes+=result.value.byteLength;
      if(bytes>131072) throw responseError('response_too_large', 'Model response too large');
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    // A broken upstream stream must not hold a model switch or Stop open.
    void reader.cancel().catch(()=>{});
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw responseError('invalid_response', 'Invalid model response'); }
}

function validateMessage(payload, useTools, definitions, actions) {
  const message=payload?.choices?.[0]?.message;
  if(!message || typeof message!=='object' || Array.isArray(message)) throw responseError('invalid_response', 'Invalid model response');
  if(message.tool_calls != null && !Array.isArray(message.tool_calls)) throw responseError('invalid_response', 'Invalid browser tool call');
  if(message.tool_calls?.length) {
    if(!useTools || message.tool_calls.length>4-actions) throw responseError('invalid_response', 'Browser action budget exceeded');
    const allowed=new Set(definitions.map(tool=>tool.function.name)), ids=new Set();
    const calls=message.tool_calls.map(call=>{
      if(!call || typeof call.id!=='string' || !call.id || call.id.length>200 || ids.has(call.id) ||
        !allowed.has(call.function?.name) || typeof call.function?.arguments!=='string' || call.function.arguments.length>10000) {
        throw responseError('invalid_response', 'Invalid browser tool call');
      }
      ids.add(call.id);
      let args;
      try { args=JSON.parse(call.function.arguments); }
      catch { throw responseError('invalid_response', 'Invalid browser tool call'); }
      if(!args || typeof args!=='object' || Array.isArray(args)) throw responseError('invalid_response', 'Invalid browser tool call');
      return {id:call.id,type:'function',function:{name:call.function.name,arguments:call.function.arguments},args};
    });
    return {message,calls};
  }
  if(typeof message.content!=='string' || !message.content.trim()) throw responseError('empty_response', 'Empty model response');
  const output=normalizeBotOutput(message.content);
  if(!JSON.parse(output.slice('SendMessage: '.length)).content.trim()) throw responseError('empty_response', 'Empty model response');
  return {message,output};
}

export class ApiLlm {
  constructor(env) {
    this.name=env.COMMUNITY_LLM_MODEL;
    this.endpoint=endpointFor(env.COMMUNITY_LLM_BASE_URL);
    this.key=env.COMMUNITY_LLM_API_KEY;
  }
  async complete(request, signal) {
    const messages=[{role:'system',content:request.system},{role:'user',content:request.images?.length ? [{type:'text',text:request.user},...request.images.map(image=>({type:'image_url',image_url:{url:image}}))] : request.user}];
    const definitions=request.toolDefinitions || BROWSER_TOOL_DEFINITIONS;
    const control=request.modelControl;
    let actions=0, candidateIndex=0, totalCalls=0, stepCalls=0, callCredit=true, selection;
    let lastReason='start', lastError=new Error('사용 가능한 모델 한도 또는 인증을 확인해 주세요.');
    const syncSelection=()=>{
      const current=control?.getSelection?.() || {};
      const revision=current.revision ?? 0;
      if(selection && revision===selection.revision) return false;
      const changed=Boolean(selection);
      selection={revision,choice:current.choice || request,signal:current.signal};
      candidateIndex=0;
      if(changed) { stepCalls=0; lastReason='switched'; }
      return changed;
    };
    const changedSince=active=>{ syncSelection(); return active.revision!==selection.revision; };
    const transition=(stage,candidate,reason)=>{
      // UI telemetry contains identifiers and fixed reason codes only.
      try { control?.onTransition?.({stage,model:safeName(candidate.model),provider:safeName(candidate.provider || candidate.name || 'community'),attempt:totalCalls,reason}); }
      catch {}
    };
    syncSelection();
    for(let step=0;step<5;step++) {
      const useTools=Boolean(request.browser) && actions<4 && step<4;
      stepCalls=0;
      for(;;) {
        signal?.throwIfAborted();
        syncSelection();
        selection.signal?.throwIfAborted();
        if(totalCalls>=MAX_CALLS) throw lastError;
        const choice=selection.choice;
        const candidates=choice.attempts?.length ? choice.attempts : [{
          apiKey:choice.apiKey || request.apiKey || this.key,
          model:choice.model || request.model || this.name,
          provider:choice.provider,
          baseUrl:choice.baseUrl || request.baseUrl || this.endpoint.href.replace(/\/chat\/completions$/, ''),
        }];
        const available=choice.isCandidateAvailable || request.isCandidateAvailable;
        while(candidateIndex<candidates.length && available && !available(candidates[candidateIndex])) candidateIndex++;
        if(stepCalls>=MAX_ATTEMPTS_PER_STEP || candidateIndex>=candidates.length) {
          const revision=selection.revision;
          if(!control?.onExhausted) throw lastError;
          const resume=await withSignal(control.onExhausted({revision,reason:lastReason,attempt:totalCalls},signal),signal);
          signal?.throwIfAborted();
          syncSelection();
          // Requiring a new revision prevents a synchronous resume loop with no new choice.
          if(!resume || revision===selection.revision) throw lastError;
          stepCalls=0;
          continue;
        }
        const candidate=candidates[candidateIndex], active=selection;
        const target=endpointFor(candidate.baseUrl);
        if(!callCredit) {
          await request.beforeAdditionalModelCall?.();
          callCredit=true;
        }
        signal?.throwIfAborted();
        if(changedSince(active)) continue;
        active.signal?.throwIfAborted();
        if(available && !available(candidate)) { candidateIndex++; continue; }
        const effort=['low','medium','high','xhigh'].includes(choice.effort) ? choice.effort : '';
        const fetchSignal=AbortSignal.any([AbortSignal.timeout(request.images?.length ? 30000 : 12000),...(signal?[signal]:[]),...(active.signal?[active.signal]:[])]);
        totalCalls++;stepCalls++;callCredit=false;
        transition('attempt',candidate,lastReason);
        request.onProgress?.('model',lastReason==='start'?'답변 작성 중':'다른 모델 연결 중');
        let response,payload,validated,failureReason,failureStatus,failureDelay,failureScope;
        try {
          response=await fetch(target,{
            method:'POST',redirect:'error',signal:fetchSignal,
            headers:{'content-type':'application/json',authorization:'Bearer '+candidate.apiKey},
            body:JSON.stringify({model:candidate.model,messages,max_tokens:request.images?.length ? 2048 : 512,
              ...(effort && (!candidate.provider || /openai|groq/.test(candidate.provider)) ? {reasoning_effort:effort}:{}),
              ...(useTools?{tools:definitions,tool_choice:'auto'}:{})}),
          });
          if(response.ok) {
            request.onProgress?.('receiving','응답 수신 중');
            payload=await readPayload(response,fetchSignal);
            validated=validateMessage(payload,useTools,definitions,actions);
          } else {
            void response.body?.cancel().catch(()=>{});
            const status=response.status;
            if(!RETRYABLE_STATUS.has(status)) throw new Error('Model provider rejected request ('+status+')');
            failureReason=httpReason(status);failureStatus=status;
            const raw=response.headers.get('retry-after');
            failureDelay=raw ? (Number.isFinite(Number(raw)) ? Number(raw)*1000 : Date.parse(raw)-Date.now()) : 0;
            lastError=new Error('사용 가능한 모델 한도 또는 인증을 확인해 주세요.');
          }
        } catch(error) {
          signal?.throwIfAborted();
          if(changedSince(active)) continue;
          active.signal?.throwIfAborted();
          if(error.responseReason) {
            failureReason=error.responseReason;failureStatus=502;failureScope={scope:'model'};lastError=error;
          } else if(error.name==='TimeoutError' || error instanceof TypeError) {
            failureReason=error.name==='TimeoutError'?'timeout':'network';failureStatus=503;
            lastError=new Error('모든 모델 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.');
          } else throw error;
        } finally {
          if(response) request.onUsage?.(usageEvent({provider:candidate.provider||candidate.name||'community',keySlot:candidate.slot,model:typeof payload?.model==='string'?payload.model:candidate.model,status:response.status,headers:response.headers,usage:payload?.usage}));
        }
        signal?.throwIfAborted();
        if(changedSince(active)) continue;
        active.signal?.throwIfAborted();
        if(failureReason) {
          lastReason=failureReason;
          transition('failure',candidate,failureReason);
          (choice.onProviderFailure || request.onProviderFailure)?.(candidate,failureStatus,failureDelay,failureScope);
          candidateIndex++;
          continue;
        }
        if(validated.calls) {
          // Validate the entire batch before any side effects. Selection changes do
          // not cancel tools: each completed result is kept for the next model.
          messages.push({role:'assistant',content:typeof validated.message.content==='string'?validated.message.content.slice(0,4000):null,tool_calls:validated.calls.map(({args,...call})=>call)});
          for(const call of validated.calls) {
            signal?.throwIfAborted();
            actions++;
            let result;
            try { result=await request.browser(call.function.name,call.args,{signal}); }
            catch(error) {
              signal?.throwIfAborted();
              result='Browser action failed: '+(error.status?error.message:'The page could not complete this action.');
            }
            messages.push({role:'tool',tool_call_id:call.id,content:String(result).slice(0,8000)});
            signal?.throwIfAborted();
          }
          lastReason='start';
          break;
        }
        transition('finish',candidate,'complete');
        return validated.output;
      }
    }
    throw new Error('Browser turn budget exhausted');
  }
}
