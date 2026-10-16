import test from 'node:test';
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {createComposerRecorder,RECORDER_MAX_BYTES,RECORDER_MAX_DURATION_MS} from '../public/composer-recorder.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>queueMicrotask(resolve));
function stream(){const track={stops:0,stop(){this.stops++;}};return {track,getTracks:()=>[track]};}
function setup(options={}){
  const requests=[],uploads=[],states=[],notices=[],timers=new Map(),instances=[];
  let current={roomId:'a',userId:'user',attachmentGeneration:0,pane:{id:'pane-a'}},timerId=0;
  class Recorder {
    static isTypeSupported(type){return type==='audio/mp4';}
    constructor(source,{mimeType}={}){if(options.constructorThrows)throw new Error('constructor');this.source=source;this.mimeType=mimeType||'audio/webm';this.state='inactive';this.listeners=new Map();instances.push(this);}
    addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener);}
    removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
    fire(type,detail={}){for(const listener of [...(this.listeners.get(type)||[])])listener(detail);}
    start(slice){if(options.startThrows)throw new Error('start');this.slice=slice;this.state='recording';}
    stop(){if(options.stopThrows)throw new Error('stop');this.state='inactive';queueMicrotask(()=>{if(options.finalChunk)this.fire('dataavailable',{data:new Blob([options.finalChunk])});this.fire('stop');});}
  }
  const controller=createComposerRecorder({
    MediaRecorder:Recorder,File,Blob,
    mediaDevices:{getUserMedia(constraints){assert.deepEqual(constraints,{audio:true});const request=deferred();requests.push(request);return request.promise;}},
    isCurrent:context=>context.roomId===current.roomId&&context.userId===current.userId&&context.pane===current.pane&&context.attachmentGeneration===current.attachmentGeneration,
    upload:async(files,context,control)=>{uploads.push({files,context,signal:control.signal});if(options.upload)return options.upload(files,context,control);},
    onState:value=>{states.push(value);options.onState?.(value,{setCurrent:value=>{current=value;},getCurrent:()=>current});},
    notify:value=>notices.push(value),now:()=>123,
    setTimer:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimer:id=>timers.delete(id),
    ...(options.maxBytes?{maxBytes:options.maxBytes}:{}),
  });
  return {controller,requests,uploads,states,notices,timers,instances,get context(){return current;},setCurrent:value=>{current=value;},
    async begin(){const source=stream(),pending=controller.start(current);requests.at(-1).resolve(source);assert.equal(await pending,true);return source;}};
}

test('one recorder captures its pane and uploads a correctly typed file after releasing microphone tracks',async()=>{
  const s=setup({finalChunk:'last'}),source=await s.begin();
  assert.equal(s.controller.status,'recording');assert.equal(await s.controller.start({...s.context,pane:{id:'other'}}),false);
  assert.equal(s.requests.length,1);assert.equal(s.instances[0].slice,1000);
  s.instances[0].fire('dataavailable',{data:new Blob(['voice'])});
  assert.equal(await s.controller.stop(),true);
  assert.equal(source.track.stops,1);assert.equal(s.controller.status,'idle');assert.equal(s.uploads.length,1);
  const {files,context}=s.uploads[0];assert.equal(context.pane,s.context.pane);assert.ok(Object.isFrozen(context));
  assert.equal(files[0].name,'voice-123.mp4');assert.equal(files[0].type,'audio/mp4');assert.equal(await files[0].text(),'voicelast');
  assert.deepEqual(s.states.map(item=>item.status),['requesting','recording','stopping','uploading','idle']);
  assert.equal(s.timers.size,0);assert.ok([...s.instances[0].listeners.values()].every(set=>set.size===0));
});

test('cancel before permission resolves releases the old stream without clobbering a newer recording',async()=>{
  const s=setup(),old=s.controller.start(s.context),oldSource=stream();
  assert.equal(s.controller.status,'requesting');s.controller.cancel();assert.equal(s.controller.status,'idle');
  const newSource=await s.begin();assert.equal(s.controller.status,'recording');
  s.requests[0].resolve(oldSource);assert.equal(await old,false);
  assert.equal(oldSource.track.stops,1);assert.equal(newSource.track.stops,0);assert.equal(s.controller.status,'recording');assert.equal(s.uploads.length,0);
  s.controller.destroy();assert.equal(newSource.track.stops,1);
});

test('room or authentication changes while permission is pending cannot create a recorder',async()=>{
  for(const patch of [{roomId:'other'},{userId:'other-user'},{attachmentGeneration:1},{pane:{id:'removed'}}]){
    const s=setup(),pending=s.controller.start(s.context),source=stream();s.setCurrent({...s.context,...patch});
    s.requests[0].resolve(source);assert.equal(await pending,false);assert.equal(source.track.stops,1);assert.equal(s.instances.length,0);assert.equal(s.controller.status,'idle');
  }
});

test('stale context at stop or immediately before upload never attaches audio to the new room',async()=>{
  const s=setup({finalChunk:'voice'}),source=await s.begin(),done=s.controller.stop();
  s.setCurrent({...s.context,roomId:'other'});await done;assert.equal(s.uploads.length,0);assert.equal(source.track.stops,1);
  const r=setup({finalChunk:'voice',onState:(value,{setCurrent,getCurrent})=>{if(value.status==='uploading')setCurrent({...getCurrent(),userId:'signed-out'});}});
  await r.begin();assert.equal(await r.controller.stop(),false);assert.equal(r.uploads.length,0);assert.equal(r.controller.status,'idle');
});

test('explicit stale cancellation and destroy release active tracks and never upload discarded chunks',async()=>{
  const s=setup(),source=await s.begin();s.instances[0].fire('dataavailable',{data:new Blob(['discard'])});
  s.setCurrent({...s.context,attachmentGeneration:1});assert.equal(s.controller.cancelIfStale(),true);await tick();
  assert.equal(source.track.stops,1);assert.equal(s.uploads.length,0);assert.equal(s.controller.status,'idle');assert.equal(s.timers.size,0);
  s.controller.destroy();assert.equal(await s.controller.start(s.context),false);
});

test('size cap discards oversized recordings and duration cap stops and uploads completed audio',async()=>{
  assert.equal(RECORDER_MAX_BYTES,12*1024*1024);assert.equal(RECORDER_MAX_DURATION_MS,120000);
  const s=setup({maxBytes:3}),source=await s.begin();s.instances[0].fire('dataavailable',{data:new Blob(['1234'])});await tick();
  assert.equal(source.track.stops,1);assert.equal(s.uploads.length,0);assert.equal(s.controller.status,'idle');assert.match(s.notices[0],/12MB/);
  const r=setup({finalChunk:'capped'}),rSource=await r.begin(),timer=[...r.timers.values()][0];assert.equal(timer.ms,120000);timer.fn();await tick();await tick();
  assert.equal(r.uploads.length,1);assert.equal(rSource.track.stops,1);assert.equal(r.controller.status,'idle');assert.match(r.notices[0],/120초/);
});

test('permission rejection, constructor/start/stop errors and recorder errors clean up all resources',async()=>{
  const denied=setup(),pending=denied.controller.start(denied.context);denied.requests[0].reject(Object.assign(new Error('denied'),{name:'NotAllowedError'}));assert.equal(await pending,false);assert.equal(denied.controller.status,'idle');assert.match(denied.notices[0],/권한/);
  for(const option of ['constructorThrows','startThrows']){
    const s=setup({[option]:true}),source=stream(),promise=s.controller.start(s.context);s.requests[0].resolve(source);assert.equal(await promise,false);assert.equal(source.track.stops,1);assert.equal(s.controller.status,'idle');assert.equal(s.timers.size,0);
  }
  const stop=setup({stopThrows:true}),source=await stop.begin();assert.equal(await stop.controller.stop(),false);assert.equal(source.track.stops,1);assert.equal(stop.controller.status,'idle');
  const error=setup(),errorSource=await error.begin();error.instances[0].fire('error');await tick();assert.equal(errorSource.track.stops,1);assert.equal(error.controller.status,'idle');assert.equal(error.uploads.length,0);
});

test('cancelling an upload aborts its signal and a late rejection cannot overwrite a newer recording',async()=>{
  const gate=deferred(),s=setup({finalChunk:'voice',upload:()=>gate.promise}),source=await s.begin();const stopped=s.controller.stop();await tick();
  assert.equal(s.controller.status,'uploading');assert.equal(source.track.stops,1);s.controller.cancel();assert.equal(await stopped,false);assert.equal(s.uploads[0].signal.aborted,true);
  const nextSource=await s.begin();gate.reject(new Error('late upload failure'));await tick();await tick();assert.equal(s.controller.status,'recording');assert.equal(nextSource.track.stops,0);assert.equal(s.notices.length,0);s.controller.destroy();
});


test('empty or failed uploads always return idle without holding the microphone',async()=>{
  const empty=setup(),source=await empty.begin();assert.equal(await empty.controller.stop(),false);assert.equal(empty.uploads.length,0);assert.equal(source.track.stops,1);assert.equal(empty.controller.status,'idle');
  const failed=setup({finalChunk:'voice',upload:async()=>{throw new Error('upload unavailable');}}),failedSource=await failed.begin();
  assert.equal(await failed.controller.stop(),false);assert.equal(failedSource.track.stops,1);assert.equal(failed.controller.status,'idle');assert.deepEqual(failed.notices,['upload unavailable']);assert.equal(failed.timers.size,0);
});
