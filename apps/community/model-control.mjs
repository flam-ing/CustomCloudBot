import { randomUUID } from 'node:crypto';

const reasonFor = value => /rate_limit|limit/.test(value || '') ? 'limit' :
  /authentication|unavailable/.test(value || '') ? 'unavailable' :
  /response/.test(value || '') ? 'response' : value === 'switched' ? 'switch' : 'connection';
const safeName = value => typeof value === 'string' ? value.replace(/[^\w.:/@+ -]/g, '').slice(0, 200) : '';

// Changing the model cancels only the current model HTTP request. The turn's
// controller (and any tool already running) is cancelled only by explicit stop.
export function createRunModelControl({userId, choice, signal, publish, waitMs=120000}) {
  let revision=0, selection=choice, selectionController=new AbortController(), closed=false;
  const waiters=new Set();
  let status={runId:randomUUID(),userId,phase:'trying',visible:false,automatic:choice?.automatic!==false,
    model:safeName(choice?.model),provider:safeName(choice?.provider),attempt:0,reason:'connection',sequence:0,startedAt:Date.now()};
  const update=changes=>{status={...status,...changes,sequence:status.sequence+1};try { publish?.({...status}); } catch { /* Notification delivery cannot cancel model work. */ }};
  const wake=()=>{for(const waiter of [...waiters])waiter();};
  const getSelection=()=>({revision,choice:selection,signal:selectionController.signal});
  function switchChoice(next) {
    if(closed||signal.aborted)return false;
    const old=selectionController;
    selection=next;revision++;selectionController=new AbortController();
    update({visible:true,phase:'switching',automatic:next.automatic!==false,reason:'switch'});
    old.abort();wake();return true;
  }
  function onTransition(event) {
    if(closed||signal.aborted)return;
    if(event.stage==='failure')update({visible:true,phase:'switching',reason:reasonFor(event.reason)});
    else if(event.stage==='attempt')update({phase:'trying',model:safeName(event.model),provider:safeName(event.provider),attempt:event.attempt,
      automatic:selection?.automatic!==false});
    else if(event.stage==='finish')update({visible:false});
  }
  async function onExhausted(event,turnSignal=signal) {
    if(closed||turnSignal.aborted)return false;
    if(event.revision!==revision)return true;
    update({visible:true,phase:'waiting',reason:reasonFor(event.reason),attempt:event.attempt});
    return new Promise(resolve=>{
      let timer;
      const done=()=>{
        clearTimeout(timer);waiters.delete(done);turnSignal.removeEventListener('abort',done);
        resolve(!closed&&!turnSignal.aborted&&revision!==event.revision);
      };
      waiters.add(done);turnSignal.addEventListener('abort',done,{once:true});
      timer=setTimeout(done,Math.max(1,Math.min(120000,waitMs)));timer.unref?.();
      if(closed||turnSignal.aborted||revision!==event.revision)done();
    });
  }
  function finish(outcome) {
    if(closed)return;
    closed=true;selectionController.abort();wake();
    if(outcome==='complete')update({visible:false,phase:'complete'});
    else update({visible:true,phase:outcome==='stopped'?'stopped':'exhausted'});
  }
  return {getSelection,switchChoice,onTransition,onExhausted,finish,
    get status(){return {...status};}, get active(){return !closed&&!signal.aborted;}};
}
