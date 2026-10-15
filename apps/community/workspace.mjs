import {randomBytes,createHash} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(status,message)=>Object.assign(new Error(message),{status});
const terminalPath=/^\/api\/rooms\/([a-f0-9-]{36})\/workspace\/terminal\/ws$/;
const MAX_FILE=8*1024*1024;
const INPUT_MODES=new Set(['text','decimal','numeric','tel','search','email','url']);
const INPUT_REGION_LIMIT=256,INPUT_COORDINATE_LIMIT=32768;

/** Only editable screen bounds cross this boundary, never accessibility text or values. */
export function browserInputRegions(value){
  if(value?.available!==true||!Array.isArray(value.regions))return {available:false,regions:[]};
  const regions=[];
  for(const region of value.regions.slice(0,INPUT_REGION_LIMIT)){
    if(!region||!['x','y','width','height'].every(key=>typeof region[key]==='number'&&Number.isFinite(region[key])))continue;
    const {x,y,width,height}=region;
    if(x<0||y<0||width<=0||height<=0||x+width>INPUT_COORDINATE_LIMIT||y+height>INPUT_COORDINATE_LIMIT)continue;
    regions.push({x,y,width,height,...(INPUT_MODES.has(region.inputMode)?{inputMode:region.inputMode}:{})});
  }
  return {available:true,regions};
}

export function workspaceEndpoint(config){
  if(!config?.cdpUrl)throw fail(503,'작업 공간이 연결되지 않았습니다.');
  const cdp=new URL(config.cdpUrl),base=new URL(config.workspaceUrl||config.cdpUrl);
  if(!config.workspaceUrl)base.port='6083';
  if(base.protocol!=='http:'||base.hostname!==cdp.hostname||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw fail(503,'작업 공간 연결 설정을 확인해주세요.');
  return base;
}
export function workspacePath(value=''){
  if(typeof value!=='string'||value.length>2048||value.includes('\0')||value.includes('\\')||value.startsWith('/')||value.split('/').some(part=>part==='..'))throw fail(400,'올바른 작업 공간 경로가 필요합니다.');
  return value.split('/').filter(part=>part&&part!=='.').join('/');
}
async function boundedBody(response,maximum){
  const parts=[];let size=0;
  const reader=response.body.getReader();
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum)throw fail(413,'파일 또는 응답 크기가 너무 큽니다.');parts.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(parts);
}
export function createWorkspaceHub({server,desktops,userFor,roomFor,originFor,touch=()=>{},fetchImpl=fetch}){
  const tickets=new Map(),connections=new Set(),inputRegionsCache=new Map();
  const wss=new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:32768});
  async function remote(roomId,path,maximum=256*1024,timeout=10000){
    const base=workspaceEndpoint(desktops.get(roomId));
    let response;
    try{response=await fetchImpl(new URL(path,base),{redirect:'error',signal:AbortSignal.timeout(timeout)});}
    catch{throw fail(503,'OCI 작업 공간에 연결하지 못했습니다. 잠시 후 다시 연결해주세요.');}
    if(!response.ok){await response.body?.cancel();throw fail([400,403,404,413,429].includes(response.status)?response.status:503,'작업 공간 요청을 처리하지 못했습니다.');}
    return boundedBody(response,maximum);
  }
  function ticket(user,roomId){
    workspaceEndpoint(desktops.get(roomId));
    const now=Date.now();for(const [key,entry] of tickets)if(entry.expiresAt<=now)tickets.delete(key);
    if(tickets.size>=200)throw fail(429,'터미널 연결 요청이 많습니다.');
    const raw=randomBytes(32).toString('base64url'),expiresAt=now+60000;
    tickets.set(hash(raw),{userId:user.id,roomId,sessionHash:user.sessionHash,expiresAt});
    return {websocketPath:`/api/rooms/${roomId}/workspace/terminal/ws?ticket=${raw}`,expiresAt};
  }
  const reject=(socket,status)=>socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  server.on('upgrade',(req,socket,head)=>{
    const url=new URL(req.url,'http://local'),match=url.pathname.match(terminalPath);if(!match)return;
    let user,roomId,base;
    try{
      if(!originFor(req)||req.headers.origin!==originFor(req))return reject(socket,403);
      user=userFor(req);if(!user)return reject(socket,401);
      roomId=match[1];roomFor(roomId,user);base=workspaceEndpoint(desktops.get(roomId));
      const raw=url.searchParams.get('ticket')||'';if(raw.length>100)return reject(socket,403);
      const key=hash(raw),entry=tickets.get(key);
      if(!entry||entry.expiresAt<=Date.now()||entry.userId!==user.id||entry.roomId!==roomId||entry.sessionHash!==user.sessionHash)return reject(socket,403);
      tickets.delete(key);
      if(connections.size>=16||[...connections].filter(c=>c.userId===user.id).length>=8)return reject(socket,429);
    }catch{return reject(socket,403);}
    wss.handleUpgrade(req,socket,head,client=>{
      const target=new URL('/terminal',base);target.protocol='ws:';target.searchParams.set('session',hash(user.id+'\0'+roomId));
      // Server-to-container only: never forward cookies, Origin, or credentials.
      const upstream=new WebSocket(target,{perMessageDeflate:false,maxPayload:512*1024,handshakeTimeout:5000});
      const entry={client,upstream,userId:user.id},pending=[];let queuedBytes=0,closed=false;
      connections.add(entry);
      const cleanup=()=>{if(closed)return;closed=true;connections.delete(entry);client.terminate();upstream.terminate();};
      const authorized=()=>{try{const current=userFor(req);if(!current||current.sessionHash!==user.sessionHash)throw new Error('Session ended');roomFor(roomId,current);return true;}catch{cleanup();return false;}};
      const send=(dest,data)=>{if(dest.readyState!==WebSocket.OPEN||dest.bufferedAmount>256*1024)return cleanup();dest.send(data,{binary:false},error=>{if(error)cleanup();});};
      upstream.on('open',()=>{if(!authorized())return;for(const data of pending)send(upstream,data);pending.length=0;queuedBytes=0;});
      upstream.on('message',(data,binary)=>{if(binary)return cleanup();if(authorized())send(client,data);});
      client.on('message',(data,binary)=>{
        if(!authorized())return;
        if(binary)return cleanup();
        let value;try{value=JSON.parse(data.toString());}catch{return cleanup();}
        const valid=value?.type==='input'?typeof value.data==='string'&&Buffer.byteLength(value.data)<=16384:value?.type==='resize'&&Number.isInteger(value.cols)&&value.cols>=2&&value.cols<=400&&Number.isInteger(value.rows)&&value.rows>=2&&value.rows<=200;
        if(!valid)return cleanup();
        const encoded=JSON.stringify(value.type==='input'?{type:'input',data:value.data}:{type:'resize',cols:value.cols,rows:value.rows});
        if(upstream.readyState===WebSocket.CONNECTING){queuedBytes+=Buffer.byteLength(encoded);if(queuedBytes>32768)return cleanup();pending.push(encoded);}else send(upstream,encoded);
      });
      upstream.on('error',()=>client.close(1011,'Terminal unavailable'));client.on('error',cleanup);
      client.on('close',cleanup);upstream.on('close',()=>client.close());
      const monitor=setInterval(()=>{try{const current=userFor(req);if(!current||current.sessionHash!==user.sessionHash)return cleanup();roomFor(roomId,current);touch(roomId);}catch{cleanup();}},10000);monitor.unref();
      const lifetime=setTimeout(()=>client.close(1000,'Reconnect terminal'),3600000);lifetime.unref();
      client.once('close',()=>{clearInterval(monitor);clearTimeout(lifetime);});
    });
  });
  return {
    ticket,
    async inputRegions(roomId){
      // Rooms on the shared desktop reuse the same short-lived geometry snapshot.
      // The HTTP route still checks each requesting user's room membership.
      const key=workspaceEndpoint(desktops.get(roomId)).href,now=Date.now(),cached=inputRegionsCache.get(key);
      if(cached?.pending)return cached.pending;
      if(cached?.expiresAt>now)return cached.value;
      if(inputRegionsCache.size>=64)inputRegionsCache.delete(inputRegionsCache.keys().next().value);
      const entry={pending:null,value:null,expiresAt:0};inputRegionsCache.set(key,entry);
      entry.pending=(async()=>{
        const raw=await remote(roomId,'/browser/input-regions',65536,2000);
        let result;try{result=JSON.parse(raw.toString());}catch{throw fail(503,'브라우저 입력 위치를 확인하지 못했습니다.');}
        entry.value=browserInputRegions(result);entry.expiresAt=Date.now()+200;return entry.value;
      })();
      try{return await entry.pending;}
      catch(error){if(inputRegionsCache.get(key)===entry)inputRegionsCache.delete(key);throw error;}
      finally{entry.pending=null;}
    },
    async status(roomId){let healthy=false;try{healthy=JSON.parse((await remote(roomId,'/health',4096)).toString()).ok===true;}catch{}
      return {browser:desktops.has(roomId),terminal:healthy,files:healthy,shared:!!desktops.sharedRoomId};},
    async files(roomId,path){const clean=workspacePath(path);return JSON.parse((await remote(roomId,'/files?path='+encodeURIComponent(clean))).toString());},
    async file(roomId,path){return remote(roomId,'/file?path='+encodeURIComponent(workspacePath(path)),MAX_FILE);},
    close(){tickets.clear();inputRegionsCache.clear();for(const {client,upstream}of connections){client.terminate();upstream.terminate();}connections.clear();wss.close();},
  };
}
