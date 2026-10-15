import {downloadRoomExport, formatRoomExport, loadRoomExport} from "./room-export.js";

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
export function createRoomSharing({api, getSession, onRoomCreated, onInvite, toast}) {
  let dialog, generation = 0, controller, restoreFocus;
  function close() { generation += 1; controller?.abort(); controller=null; if (dialog?.open) dialog.close(); dialog?.replaceChildren(); if(restoreFocus?.isConnected)restoreFocus.focus(); restoreFocus=null; }
  function ensureDialog() {
    if (dialog) return;
    dialog = element("dialog", "room-sharing-dialog"); dialog.setAttribute("aria-labelledby", "room-sharing-title");
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    dialog.addEventListener("click", event => {if(event.target===dialog){const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)close();}});
    document.body.append(dialog);
  }
  function header(titleText) {
    const header = element("header", "room-sharing-header"), title = element("h2", "", titleText); title.id="room-sharing-title";
    const exit=element("button","icon-button","×");exit.type="button";exit.setAttribute("aria-label","공유 설정 닫기");exit.addEventListener("click",close);header.append(title,exit);return header;
  }
  function option(title, detail, path) {
    const button=element("button","room-sharing-option");button.type="button";
    const icon=document.createElementNS("http://www.w3.org/2000/svg","svg");icon.setAttribute("viewBox","0 0 24 24");icon.setAttribute("aria-hidden","true");
    const shape=document.createElementNS("http://www.w3.org/2000/svg","path");shape.setAttribute("d",path);icon.append(shape);
    const text=element("span","room-sharing-option-text");text.append(element("strong","",title),element("small","",detail));button.append(icon,text);return button;
  }
  function open(room) {
    const user = getSession()?.user;
    if (!user || !room) return;
    close();
    restoreFocus=document.activeElement;ensureDialog();
    const active = generation, userId = user.id;
    const current = () => active === generation && dialog.open && getSession()?.user?.id === userId;
    const content=element("section","room-sharing-menu"), name=element("p","room-sharing-room-name",room.name || "대화");
    const canInvite=room.sharing?.canInvite ?? (!room.personal && room.role==="owner");
    const canCopy=room.sharing?.canCreateSharedCopy ?? (room.personal && room.role==="owner");
    const link=option("링크 공유",canCopy?"함께 쓸 사본을 만들고 초대하기":canInvite?"초대 링크로 함께 대화하기":"현재 참여자에게 대화 링크 보내기","M10 13a5 5 0 0 0 7.1 0l3-3A5 5 0 0 0 13 3l-1.7 1.7 M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21l1.7-1.7");
    const markdown=option("Markdown 다운로드","전체 메시지 · 읽기 쉬운 문서 (.md)","M12 3v12m-5-5 5 5 5-5M5 15v5h14v-5");
    const json=option("JSON 다운로드","전체 메시지 · 데이터 보관용 (.json)","m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18");
    const status=element("p","room-sharing-status");status.setAttribute("role","status");
    content.append(header("대화 공유"),name,link,element("div","room-sharing-divider"),markdown,json,element("p","room-sharing-copy room-sharing-export-note","첨부 파일은 다운로드 문서에 원본 링크로 포함됩니다."),status);
    const busy=value=>{for(const button of [link,markdown,json])button.disabled=value;content.setAttribute("aria-busy",String(value));};
    link.addEventListener("click",async()=>{
      if(!current()||link.disabled)return;
      if(canCopy){sharedCopy(room,current,userId);return;}
      if(canInvite){close();await onInvite?.(room);return;}
      busy(true);status.textContent="";
      try{
        const url=new URL("/",window.location.origin);url.searchParams.set("room",room.id);
        await navigator.clipboard.writeText(url.href);
        if(current()){status.textContent="링크를 복사했습니다. 현재 참여자만 열 수 있습니다.";busy(false);}
      }catch{if(current()){status.textContent="링크를 복사하지 못했습니다. 아래 주소를 복사해 주세요.";const input=element("input","room-sharing-link");input.readOnly=true;input.value=new URL(`/?room=${encodeURIComponent(room.id)}`,window.location.origin).href;input.setAttribute("aria-label","현재 참여자 전용 대화 링크");status.append(input);input.focus();input.select();busy(false);}}
    });
    for(const [button,format] of [[markdown,"markdown"],[json,"json"]])button.addEventListener("click",async()=>{
      if(!current()||button.disabled)return;
      busy(true);status.textContent="대화 기록을 모으는 중…";controller=new AbortController();
      try{
        const data=await loadRoomExport({api,roomId:room.id,signal:controller.signal,isCurrent:current,onProgress:count=>{if(current())status.textContent=`메시지 ${count.toLocaleString()}개 준비 중…`;}});
        if(!current())return;
        downloadRoomExport(formatRoomExport(data,format,{origin:window.location.origin}));status.textContent="다운로드를 시작했습니다.";
      }catch(error){if(current()&&error.name!=="AbortError")status.textContent=error.message||"대화를 내려받지 못했습니다.";}
      finally{if(current()){controller=null;busy(false);}}
    });
    dialog.replaceChildren(content);dialog.showModal();link.focus();
  }
  function sharedCopy(room,current,userId) {
    const form = element("form", "room-sharing-form");
    const explanation = element("p", "room-sharing-copy", "개인 대화를 그대로 보관하고, 여러 명이 참여할 새 세션을 만듭니다.");
    const nameLabel = element("label", "room-sharing-field", "함께 쓸 대화 이름");
    const name = element("input"); name.name = "name"; name.required = true; name.maxLength = 80; name.value = String(room.name || "대화").slice(0, 65) + " · 함께 대화"; nameLabel.append(name);
    const historyLabel = element("label", "room-sharing-history");
    const history = element("input"); history.type = "checkbox"; history.name = "includeHistory"; history.checked = false;
    historyLabel.append(history, element("span", "", "이전 메시지와 첨부 파일도 복사"));
    const note = element("p", "room-sharing-note", "이 옵션을 켜면 기존 메일·캘린더 조회 결과 등 대화에 남아 있는 내용도 참여자에게 보입니다. 개인 연결 서비스 접근 권한은 복사하지 않습니다.");
    const status = element("p", "room-sharing-status"); status.setAttribute("role", "status");
    const submit = element("button", "primary-button", "세션 만들고 초대 링크 받기"); submit.type = "submit";
    form.append(header("함께 대화하기"), explanation, nameLabel, historyLabel, note, status, submit);
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (!current() || submit.disabled) return;
      submit.disabled = true; status.textContent = "";
      try {
        const result = await api(`/api/rooms/${encodeURIComponent(room.id)}/shared-copy`, {method: "POST", body: JSON.stringify({name: name.value.trim(), includeHistory: history.checked, confirmed: true})});
        if (!current()) return;
        close(); await onRoomCreated?.(result.room);
        if (getSession()?.user?.id === userId) onInvite?.(result.room);
      } catch (error) { if (current()) { status.textContent = error.message || "공유 세션을 만들지 못했습니다."; submit.disabled = false; } }
    });
    dialog.replaceChildren(form); name.focus();
  }
  return {open, close, destroy() { close(); dialog?.remove(); dialog = null; }};
}
