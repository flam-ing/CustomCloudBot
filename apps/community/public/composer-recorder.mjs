export const RECORDER_MAX_BYTES = 12 * 1024 * 1024;
export const RECORDER_MAX_DURATION_MS = 2 * 60 * 1000;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

/** One controller is shared by all composers. Context must identify the captured
 * user, room, pane and attachment generation; isCurrent checks those identities.
 * Cancel on logout/removal, or call cancelIfStale after room/layout changes. */
export function createComposerRecorder({
  isCurrent, upload, onState=()=>{}, notify=()=>{},
  mediaDevices=globalThis.navigator?.mediaDevices,
  MediaRecorder: Recorder=globalThis.MediaRecorder,
  File: FileType=globalThis.File, Blob: BlobType=globalThis.Blob,
  setTimer=globalThis.setTimeout, clearTimer=globalThis.clearTimeout, now=Date.now,
  maxBytes=RECORDER_MAX_BYTES, maxDurationMs=RECORDER_MAX_DURATION_MS,
}={}) {
  let active=null, destroyed=false;
  const current=entry=>{try{return !destroyed && isCurrent(entry.context);}catch{return false;}};
  const emit=()=>{try{onState({status:active?.status||'idle',context:active?.context||null});}catch{}};
  const say=message=>{try{notify(message);}catch{}};
  const stopTracks=entry=>{
    if(!entry.stream || entry.tracksStopped)return;
    entry.tracksStopped=true;
    let tracks=[];try{tracks=entry.stream.getTracks();}catch{}
    for(const track of tracks)try{track.stop();}catch{}
    entry.stream=null;
  };
  const removeListeners=entry=>{
    for(const [type,listener] of entry.listeners)entry.recorder?.removeEventListener(type,listener);
    entry.listeners=[];
  };
  const clearRecordingTimer=entry=>{if(entry.timer!==null){clearTimer(entry.timer);entry.timer=null;}};
  const finish=(entry,success=false)=>{
    clearRecordingTimer(entry);stopTracks(entry);removeListeners(entry);
    entry.chunks=[];entry.recorder=null;
    if(!entry.done){entry.done=true;entry.resolve(success);}
    if(active===entry){active=null;emit();}
  };
  const cancelEntry=entry=>{
    if(!entry)return false;
    entry.cancelled=true;entry.abort.abort();
    clearRecordingTimer(entry);removeListeners(entry);
    const recorder=entry.recorder;
    try{if(recorder && recorder.state!=='inactive')recorder.stop();}catch{}
    finish(entry);
    return true;
  };
  const finalizeRecording=async entry=>{
    if(entry.finalizing || entry.done)return;
    entry.finalizing=true;clearRecordingTimer(entry);stopTracks(entry);removeListeners(entry);
    if(active!==entry || entry.cancelled || !current(entry) || !entry.chunks.length){finish(entry);return;}
    try{
      const mimeType=entry.recorder?.mimeType || entry.chunks.find(chunk=>chunk.type)?.type || 'audio/webm';
      const extension=mimeType.includes('mp4')?'mp4':mimeType.includes('ogg')?'ogg':'webm';
      const blob=new BlobType(entry.chunks,{type:mimeType});
      const file=new FileType([blob],`voice-${now()}.${extension}`,{type:mimeType});
      entry.chunks=[];entry.recorder=null;
      entry.status='uploading';emit();
      if(active!==entry || entry.cancelled || !current(entry)){finish(entry);return;}
      await upload([file],entry.context,{signal:entry.abort.signal});
      finish(entry,active===entry && !entry.cancelled && current(entry));
    }catch(error){
      if(active===entry && !entry.cancelled && current(entry))say(error?.message || '녹음 파일을 첨부하지 못했습니다.');
      finish(entry);
    }
  };
  const stop=()=>{
    const entry=active;
    if(!entry)return Promise.resolve(false);
    if(entry.status!=='recording')return entry.completion;
    if(!current(entry)){cancelEntry(entry);return entry.completion;}
    entry.status='stopping';clearRecordingTimer(entry);emit();
    if(active!==entry || entry.cancelled)return entry.completion;
    try{entry.recorder.stop();stopTracks(entry);}
    catch{if(current(entry))say('음성 녹음을 마무리하지 못했습니다.');cancelEntry(entry);}
    return entry.completion;
  };
  const start=async context=>{
    if(destroyed || active)return false;
    const captured=Object.freeze({...context});
    const entry={context:captured,status:'requesting',stream:null,tracksStopped:false,recorder:null,
      chunks:[],bytes:0,listeners:[],timer:null,cancelled:false,done:false,finalizing:false,abort:new AbortController()};
    entry.completion=new Promise(resolve=>{entry.resolve=resolve;});
    if(!current(entry))return false;
    if(!Recorder || !mediaDevices?.getUserMedia || !FileType || !BlobType){
      say('이 브라우저에서는 음성 녹음을 사용할 수 없어요. 음성 파일을 첨부해주세요.');return false;
    }
    active=entry;emit();
    if(active!==entry || entry.cancelled)return false;
    try{entry.stream=await mediaDevices.getUserMedia({audio:true});}
    catch(error){
      if(active===entry && !entry.cancelled && current(entry))say(error?.name==='NotAllowedError'?'마이크 권한이 필요합니다.':'마이크를 사용할 수 없습니다.');
      finish(entry);return false;
    }
    // A permission prompt can finish after navigation or after a newer recording
    // started. Release that stale stream without disturbing the newer controller.
    if(active!==entry || entry.cancelled || !current(entry)){stopTracks(entry);finish(entry);return false;}
    let mimeType;
    try{mimeType=MIME_TYPES.find(type=>Recorder.isTypeSupported?.(type));}catch{}
    try{
      entry.recorder=new Recorder(entry.stream,mimeType?{mimeType}:undefined);
      const listen=(type,listener)=>{entry.recorder.addEventListener(type,listener);entry.listeners.push([type,listener]);};
      listen('dataavailable',event=>{
        if(active!==entry || entry.cancelled || entry.done)return;
        if(!current(entry)){cancelEntry(entry);return;}
        const size=event.data?.size || 0;
        if(!size)return;
        if(entry.bytes+size>maxBytes){say('녹음이 12MB에 도달해 중지되었습니다.');cancelEntry(entry);return;}
        entry.bytes+=size;entry.chunks.push(event.data);
      });
      listen('error',()=>{
        if(active===entry && !entry.cancelled && current(entry))say('음성 녹음 중 오류가 발생했습니다.');
        cancelEntry(entry);
      });
      listen('stop',()=>{void finalizeRecording(entry);});
      entry.recorder.start(1000);
      if(active!==entry || entry.done)return false;
      entry.status='recording';emit();
      if(active!==entry || entry.done)return false;
      entry.timer=setTimer(()=>{
        if(active===entry && entry.status==='recording'){
          if(current(entry))say(`녹음은 최대 ${Math.round(maxDurationMs/1000)}초까지 가능합니다.`);
          void stop();
        }
      },maxDurationMs);
      return true;
    }catch{
      if(active===entry && current(entry))say('이 브라우저에서 지원하는 녹음 형식이 없습니다.');
      cancelEntry(entry);return false;
    }
  };
  return {
    start,stop,
    cancel:()=>cancelEntry(active),
    cancelIfStale:()=>active && !current(active)?cancelEntry(active):false,
    get status(){return active?.status||'idle';},
    get context(){return active?.context||null;},
    destroy(){if(destroyed)return;destroyed=true;cancelEntry(active);},
  };
}
