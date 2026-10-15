const MONITOR_ROOM = "00000000-0000-4000-8000-000000000001";
import { renderMessageText } from "/message-format.mjs";
import { recommendedModels, modelLabel, filterModels } from "/model-picker.mjs";
import { createDesktopUI } from "/desktop.js";
import { createPwaController } from "/pwa.js";
import { applyBrand, createBotSetupUI } from "/setup.js";
import { createMailUI } from "/mail.js";
import { createAgentPresence, resolveAgentPresence } from "/agent-presence.js";
import { createNotificationCenter } from "/notification-center.js";
import { createInviteLink, createInviteLinks } from "/invite-links.mjs";
import { createProfileSettings } from "/profile-settings.js";
import { createRoomSharing } from "/room-sharing.js";
import { mergePendingMessages, failedOutcome } from "/conversation-ui.mjs";
import { layoutBranches, relatedBranchIds } from "/branch-graph.mjs";
import { createRoutineUI } from "/routines.js";
import { createVoiceCall } from "/voice-call.js";
import { createMessageQueue } from "/message-queue.js";
import { pasteComposerImages, uploadAttachmentFiles, clearAttachmentDraft, removeAttachmentDraft } from "/composer-attachments.mjs";
import { suggestTopicSwitch } from "/topic-switch.mjs";
const inviteLinks = createInviteLinks();

let dockRects = [{x:0,y:0,w:1,h:1}];
let pendingDock = null;
const state = {
  session: null,
  rooms: [],
  forks: [],
  bots: [],
  selectedRoom: null,
  roomData: null,
  selectedBots: [],
  botChoiceTouched: false,
  pollTimer: null,
  pollBusy: false,
  sending: false,
  pendingSend: null,
  roomRequest: 0,
  pendingAttachments: [],
  recording: null,
  recordingPending: false,
  recordingCancelled: false,
  attachmentGeneration: 0,
  layout: 1,
  extra: [],
  focusPane: 0,
  models: [],
};
let desktopUI;
let pwaUI;
let setupUI;
let mailUI;
let agentPresence;
let notificationUI;
let profileUI;
let sharingUI;
let routineUI;
let voiceUI;
let messageQueueUI;
const topicPrompts = new Set();
const pendingMessages = new Map();
const presenceTurns = new Map();
const presenceErrors = new Set();
const branchOperations = new Set();
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const els = {
  auth: $("#auth-view"),
  workspace: $("#workspace-view"),
  authMessage: $("#auth-message"),
  login: $("#login-form"),
  register: $("#register-form"),
  roomList: $("#room-list"),
  empty: $("#empty-state"),
  roomView: $("#room-view"),
  roomTitle: $("#room-title"),
  mobileRoomTitle: $("#mobile-room-title"),
  roomDescription: $("#room-description"),
  roomKicker: $("#room-kicker"),
  messages: $("#message-list"),
  memberList: $("#member-list"),
  memberCount: $("#member-count"),
  memberPanel: $("#member-panel"),
  modelWarning: $("#model-warning"),
  demoBadge: $("#demo-badge"),
  usage: $("#usage-label"),
  sendingStatus: $("#sending-status"),
  toast: $("#toast"),
};
const api = async (path, options = {}, retry = 0) => {
  const isFormData = options.body instanceof FormData;
  const headers = {
    Accept: "application/json",
    ...(options.body && !isFormData ? { "Content-Type": "application/json" } : {}),
    ...(state.session?.csrfToken
      ? { "X-CSRF-Token": state.session.csrfToken }
      : {}),
    ...(options.headers || {}),
  };
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
    });
  } catch (error) {
    if (retry < 1 && options.retryable) return api(path, options, retry + 1);
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "요청을 처리하지 못했습니다.");
    error.status = response.status;
    throw error;
  }
  return payload;
};
const setBusy = (button, busy, label) => {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.previousLabel = button.textContent;
    button.textContent = label;
  } else if (button.dataset.previousLabel) {
    button.textContent = button.dataset.previousLabel;
    delete button.dataset.previousLabel;
  }
};
const formDataObject = (form) =>
  Object.fromEntries(new FormData(form).entries());
const showMessage = (target, message, type = "error") => {
  target.textContent = message || "";
  target.className = `form-message ${type}`;
};
const toast = (message) => {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(
    () => els.toast.classList.remove("is-visible"),
    2800,
  );
};
const initials = (name) => (name || "?").trim().slice(0, 1).toUpperCase();
function renderAgentLinks() {
  let links=$("#agent-workspaces");
  if(!links){links=document.createElement("div");links.id="agent-workspaces";links.className="agent-workspaces";$(".branch-heading").before(links);}
  links.replaceChildren();
  const routines=document.createElement("button");routines.type="button";routines.id="open-routines";routines.textContent="루틴";
  routines.onclick=()=>{
    const pane=state.focusPane>0?state.extra[state.focusPane-1]:null;
    const id=pane?.roomId||state.selectedRoom,room=state.rooms.find(item=>item.id===id);
    if(!room||id===MONITOR_ROOM||room.archived){toast("루틴을 실행할 대화를 먼저 선택해 주세요.");return;}
    void routineUI?.open(room,{model:pane?.model??$("#model-select").value,effort:pane?.effort??$("#effort-select").value});
  };links.append(routines);
  if(state.session?.user?.role==="admin") {
    const setup=document.createElement("button");setup.type="button";setup.textContent="내 봇 설정";setup.onclick=()=>void setupUI?.open();links.append(setup);
    const mail=document.createElement("button");mail.type="button";mail.append(icon("mail"));const mailLabel=document.createElement("span");mailLabel.textContent="메일";mail.append(mailLabel);mail.onclick=()=>void mailUI?.open();links.append(mail);
    const hub=document.createElement("button");hub.textContent="통합 관리";hub.onclick=openCapabilityHub;links.append(hub);
  }
  for(const room of state.rooms.filter(r=>!r.archived&&r.id===MONITOR_ROOM)) {
    const button=document.createElement("button");button.type="button";
    button.append(icon("activity"));
    const label=document.createElement("span");label.textContent="대시보드";button.append(label);
    button.onclick=()=>selectRoom(room.id);links.append(button);
  }
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}
const formatDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};
function switchAuth(tab) {
  const login = tab === "login";
  $$(".tab-button").forEach((button) => {
    const active = button.dataset.authTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  els.login.classList.toggle("is-hidden", !login);
  els.register.classList.toggle("is-hidden", login);
  showMessage(els.authMessage, "");
  (login ? $("#login-username") : $("#register-display")).focus();
}
async function loadSession() {
  const startup = $("#startup-view");
  $("#startup-retry").classList.add("is-hidden");
  $("#startup-status").textContent = "내 공간을 불러오고 있어요";
  try {
    state.session = await api("/api/session", { signal: AbortSignal.timeout(15000) });
    applyBrand(state.session.brand);
    if (pwaUI?.setAppOrigin(state.session.brand?.appOrigin)) return;
    if (state.session.user) void enterWorkspace().catch(() => toast("대화 목록을 불러오지 못했습니다. 새로고침해주세요."));
    else showAuth();
    startup.classList.add("is-ready");
    setTimeout(() => startup.classList.add("is-hidden"), 300);
  } catch {
    $("#startup-status").textContent = "연결이 잠시 늦어지고 있어요. 다시 시도해주세요.";
    $("#startup-retry").classList.remove("is-hidden");
  }
}
$("#startup-retry").addEventListener("click", loadSession);
function showAuth() {
  voiceUI?.reset();
  messageQueueUI?.reset();
  messageQueueUI?.render($("#composer-form"), null);
  agentPresence?.reset(); presenceErrors.clear(); presenceTurns.clear(); pendingMessages.clear(); notificationUI?.reset();
  profileUI?.close(); sharingUI?.close();
  setupUI?.reset();
  mailUI?.reset();
  routineUI?.reset();topicPrompts.clear();document.querySelector(".topic-choice-dialog")?.close();
  closeContextPopover();
  resetSidebarState();
  modelChanges.clear();
  cancelActiveRecording();
  pwaUI?.setSession(null);
  els.auth.classList.remove("is-hidden");
  els.workspace.classList.add("is-hidden");
  stopPolling();
  state.selectedRoom = null;
  state.roomData = null;
  state.rooms = [];
  state.forks = [];
  branchOperations.clear();
  state.bots = [];
  state.selectedBots = [];
  state.botChoiceTouched = false;
  state.pendingSend = null;
  state.sending = false;
  $("#message-input").disabled=false;$("#send-button").disabled=false;
  state.layout = 1;
  state.extra.forEach(pane => clearAttachmentDraft(pane));
  state.extra = [];
  state.focusPane = 0;
  state.models = [];
  dockRects = [{x:0,y:0,w:1,h:1}];
  pendingDock = null;
  const paneGrid = $("#pane-grid");
  if (paneGrid) {
    paneGrid.dataset.panes = "1";
    $$(".extra-pane", paneGrid).forEach((pane) => pane.remove());
  }
  $("#room-view").style.gridColumn = "";
  $("#room-view").classList.remove("is-focus");
  $$(".split-picker button").forEach((button) => {
    button.classList.remove("is-on");
    button.setAttribute("aria-pressed", "false");
  });
  clearPendingAttachments();
  desktopUI?.reset();
  state.roomRequest += 1;
  state.pollBusy = false;
  els.messages.replaceChildren();
  els.memberList.replaceChildren();
  els.roomList.replaceChildren();
  $("#message-input").value = "";
  $("#room-search").value = "";
  els.memberPanel.classList.remove("is-open");
  closeSidebar();
  $$("dialog[open]").forEach((dialog) => dialog.close());
  $("#invite-token").textContent = "";
  const pendingSite = inviteLinks.get("site");
  $("#register-token").hidden = Boolean(pendingSite); $("#register-token-label").hidden = Boolean(pendingSite);
  if (pendingSite) { $("#register-token").value = pendingSite; switchAuth("register"); }
  else { switchAuth("login"); if (inviteLinks.get("room")) showMessage(els.authMessage, "대화 초대를 받았습니다. 로그인하면 참여할 수 있습니다.", "info"); }
}
async function enterWorkspace() {
  voiceUI?.syncSession();
  applyBrand(state.session.brand);
  els.auth.classList.add("is-hidden");
  els.workspace.classList.remove("is-hidden");
  const user = state.session.user;
  $("#profile-name").textContent = user.displayName || user.username;
  $("#profile-role").textContent =
    user.role === "admin" ? "사이트 관리자" : "멤버";
  $("#profile-avatar").textContent = initials(
    user.displayName || user.username,
  );
  $("#profile-avatar").style.backgroundColor = user.avatarColor || "";
  $("#site-invite-button").classList.toggle("is-hidden", user.role !== "admin");
  renderModelConnection();
  notificationUI?.setSession(state.session);
  agentPresence?.set("idle", true);
  pwaUI?.setSession(state.session);
  resetSidebarState(user.id);
  const workspaceEpoch=sidebarEpoch;
  await Promise.all([loadSidebar(),loadRooms()]);
  if(state.session?.user?.id!==user.id||sidebarEpoch!==workspaceEpoch)return;
  if (!openPendingRoomInvite()) setupUI?.maybePrompt();
  try {
    const catalog = await api("/api/models");
    if(state.session?.user?.id!==user.id||sidebarEpoch!==workspaceEpoch)return;
    applyModels(catalog.models);
    if (!catalog.models.length) toast(!state.session.model?.configured ? "AI 연결을 설정해 주세요." : catalog.failures.length ? "모델 목록을 가져오지 못했습니다. 기본 모델로 연결됩니다." : "선택 가능한 API 모델이 없습니다. 기본 모델로 연결됩니다.");
  } catch (error) { toast(error.message || "모델 목록을 불러오지 못했습니다."); }
}
function renderModelConnection() {
  const model = state.session?.model || {};
  els.demoBadge.classList.toggle("is-hidden", !model.demo);
  els.modelWarning.classList.toggle("is-hidden", Boolean(model.configured) || Boolean(model.selectable));
}
async function refreshSetupState(data, { connectionChanged }) {
  const userId=state.session?.user?.id, workspaceEpoch=sidebarEpoch;
  if(!userId||state.session.user.role!=="admin")return;
  state.session.setupRequired=data.setupRequired===true;
  if(data.profile?.displayName) {state.session.brand={...state.session.brand,name:data.profile.displayName};applyBrand(state.session.brand);}
  if(!connectionChanged)return;
  try {
    const [session,catalog]=await Promise.all([api("/api/session"),api("/api/models")]);
    if(state.session?.user?.id!==userId||session.user?.id!==userId||workspaceEpoch!==sidebarEpoch)return;
    state.session=session;applyBrand(session.brand);renderModelConnection();applyModels(catalog.models || []);
    await loadRooms();
  } catch { if(state.session?.user?.id===userId&&workspaceEpoch===sidebarEpoch)toast("연결 설정은 저장했습니다. 모델 목록은 새로고침 후 확인해주세요."); }
}
async function loadRooms() {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId)return;
  try {
    const data = await api("/api/rooms");
    if(userId!==state.session?.user?.id||epoch!==sidebarEpoch)return;
    state.rooms = data.rooms || [];
    state.forks = data.forks || [];
    state.bots = data.bots || [];
    if (
      state.session?.model?.configured &&
      state.bots.length &&
      !state.botChoiceTouched
    ) {
      state.selectedBots = [state.bots[0].id];
    }
    els.usage.textContent = "";
    els.usage.title = data.usage ? `앱의 하루 호출 사용량 ${data.usage.used} / ${data.usage.limit}회 · 공급자 잔여량과 별개` : "";
    renderRooms();
    renderBotPicker();
    const activeRooms = state.rooms.filter(room => !room.archived && room.id !== MONITOR_ROOM);
    if (!state.rooms.some(room => room.id === state.selectedRoom && !room.archived)) {
      if (!activeRooms.length) { showEmpty(); return; }
      let last;
      try { last = sessionStorage.getItem("community-room:" + userId); } catch {}
      const requested = new URLSearchParams(window.location.search).get("room");
      await selectRoom(activeRooms.find(room => room.id === requested)?.id || activeRooms.find(room => room.id === last)?.id || activeRooms[0].id);
    }
    voiceUI?.handleLink();
  } catch (error) {
    if(userId===state.session?.user?.id&&epoch===sidebarEpoch)toast(error.message);
  }
}
let showDeletedRooms=false;
let sidebarState={userId:null,groups:[],width:280,loaded:false};
let sidebarConfirmed={groups:[],width:280};
let sidebarEpoch=0,sidebarRevision=0,sidebarWriteQueue=Promise.resolve();
let sidebarPreviewWidth=null,sidebarWidthTimer=null;
function sidebarWidthBounds(viewport=innerWidth) {
  return {min:200,max:Math.max(200,Math.min(420,viewport-360))};
}
function boundedSidebarWidth(value,viewport=innerWidth) {
  const {min,max}=sidebarWidthBounds(viewport);return Math.max(min,Math.min(max,Math.round(Number(value)||280)));
}
function applySidebarWidth() {
  const width=boundedSidebarWidth(sidebarPreviewWidth??sidebarState.width),handle=$("#sidebar-resizer");
  els.workspace.style.setProperty("--sidebar-width",width+"px");
  handle.setAttribute("aria-valuenow",String(width));handle.setAttribute("aria-valuetext",width+"픽셀");handle.setAttribute("aria-valuemax",String(sidebarWidthBounds().max));
  handle.setAttribute("aria-disabled",String(!sidebarState.loaded));
}
function resetSidebarState(userId=null) {
  sidebarEpoch+=1;sidebarRevision=0;showDeletedRooms=false;
  clearTimeout(sidebarWidthTimer);sidebarWidthTimer=null;sidebarPreviewWidth=null;
  sidebarState={userId,groups:[],width:280,loaded:false};sidebarConfirmed={groups:[],width:280};
  els.workspace.classList.remove("sidebar-resizing","sidebar-collapsed");applySidebarWidth();
  $("#create-sidebar-group").disabled=true;
}
function sidebarConfig(value) {
  return {groups:Array.isArray(value?.groups)?value.groups.map(group=>({id:group.id,name:group.name,collapsed:!!group.collapsed})):[],width:Math.max(200,Math.min(420,Number(value?.width)||280))};
}
async function loadSidebar() {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId)return;
  try {
    const config=sidebarConfig(await api("/api/sidebar",{retryable:true}));
    if(epoch!==sidebarEpoch||state.session?.user?.id!==userId)return;
    sidebarConfirmed=config;sidebarState={...config,userId,loaded:true};applySidebarWidth();renderRooms();
  }catch(error){if(epoch===sidebarEpoch){toast("대화 그룹 설정을 불러오지 못했습니다. 새로고침해 다시 시도해주세요.");}}
}
function saveSidebar(next) {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId||!sidebarState.loaded)return Promise.resolve(false);
  const config=sidebarConfig(next),revision=++sidebarRevision;
  sidebarState={...config,userId,loaded:true};applySidebarWidth();renderRooms();
  const current=()=>epoch===sidebarEpoch&&state.session?.user?.id===userId;
  const pending=sidebarWriteQueue.then(async()=>{
    if(!current())return false;
    try {
      const saved=sidebarConfig(await api("/api/sidebar",{method:"PUT",body:JSON.stringify(config)}));
      if(!current())return false;
      sidebarConfirmed=saved;
      if(revision===sidebarRevision){sidebarState={...saved,userId,loaded:true};applySidebarWidth();renderRooms();}
      return true;
    }catch(error){
      if(current()){
        if(revision===sidebarRevision){sidebarState={...sidebarConfirmed,userId,loaded:true};applySidebarWidth();renderRooms();}
        toast(error.message||"대화 목록 설정을 저장하지 못했습니다.");
      }
      return false;
    }
  });
  sidebarWriteQueue=pending.catch(()=>false);return pending;
}
function commitSidebarWidth() {
  clearTimeout(sidebarWidthTimer);sidebarWidthTimer=null;
  if(sidebarPreviewWidth==null)return;
  const width=boundedSidebarWidth(sidebarPreviewWidth);sidebarPreviewWidth=null;
  if(sidebarState.loaded&&width!==sidebarState.width)void saveSidebar({...sidebarState,width});
  else applySidebarWidth();
}
function setupSidebarResize() {
  const handle=$("#sidebar-resizer");let drag=null;
  handle.addEventListener("pointerdown",event=>{
    if(event.button!==0||!sidebarState.loaded||matchMedia("(max-width:720px)").matches)return;
    event.preventDefault();event.stopPropagation();clearTimeout(sidebarWidthTimer);
    drag={pointerId:event.pointerId,startX:event.clientX,width:boundedSidebarWidth(sidebarPreviewWidth??sidebarState.width),epoch:sidebarEpoch};
    handle.setPointerCapture(event.pointerId);handle.focus();els.workspace.classList.add("sidebar-resizing");
  });
  handle.addEventListener("pointermove",event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    if(drag.epoch!==sidebarEpoch){drag=null;return;}
    sidebarPreviewWidth=boundedSidebarWidth(drag.width+event.clientX-drag.startX);applySidebarWidth();
  });
  const finish=event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    const same=drag.epoch===sidebarEpoch;drag=null;els.workspace.classList.remove("sidebar-resizing");
    if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
    if(same)commitSidebarWidth();
  };
  handle.addEventListener("pointerup",finish);handle.addEventListener("lostpointercapture",finish);
  handle.addEventListener("pointercancel",event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;drag=null;sidebarPreviewWidth=null;els.workspace.classList.remove("sidebar-resizing");applySidebarWidth();
  });
  handle.addEventListener("keydown",event=>{
    if(!sidebarState.loaded||!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();const {min,max}=sidebarWidthBounds(),step=event.shiftKey?40:10;
    sidebarPreviewWidth=boundedSidebarWidth(event.key==="Home"?min:event.key==="End"?max:(sidebarPreviewWidth??sidebarState.width)+(event.key==="ArrowRight"?step:-step));applySidebarWidth();
    clearTimeout(sidebarWidthTimer);sidebarWidthTimer=setTimeout(commitSidebarWidth,250);
  });
  window.addEventListener("resize",applySidebarWidth);applySidebarWidth();
}
function sidebarDialog(title) {
  const dialog=document.createElement("dialog");dialog.className="sidebar-dialog";dialog.setAttribute("aria-label",title);
  const heading=document.createElement("h2");heading.textContent=title;dialog.append(heading);
  dialog.addEventListener("close",()=>dialog.remove(),{once:true});document.body.append(dialog);return dialog;
}
function openSidebarGroupEditor(group=null) {
  if(!sidebarState.loaded)return;
  const epoch=sidebarEpoch,dialog=sidebarDialog(group?"그룹 이름 변경":"새 대화 그룹"),form=document.createElement("form");
  const label=document.createElement("label");label.textContent="그룹 이름";
  const input=document.createElement("input");input.name="name";input.maxLength=40;input.required=true;input.autocomplete="off";input.value=group?.name||"";label.append(input);
  const message=document.createElement("p");message.className="form-message";message.setAttribute("role","alert");
  const actions=document.createElement("div");actions.className="sidebar-dialog-actions";
  const cancel=document.createElement("button");cancel.type="button";cancel.textContent="취소";cancel.onclick=()=>dialog.close();
  const submit=document.createElement("button");submit.type="submit";submit.textContent=group?"저장":"만들기";actions.append(cancel,submit);form.append(label,message,actions);dialog.append(form);
  form.onsubmit=async event=>{
    event.preventDefault();if(submit.disabled||epoch!==sidebarEpoch)return;
    const name=input.value.trim();if(!name){message.textContent="그룹 이름을 입력해주세요.";return;}
    if(group&&!sidebarState.groups.some(item=>item.id===group.id)){dialog.close();return;}
    if(!group&&sidebarState.groups.length>=20){message.textContent="그룹은 최대 20개까지 만들 수 있습니다.";return;}
    setBusy(submit,true,"저장 중…");
    const groups=group?sidebarState.groups.map(item=>item.id===group.id?{...item,name}:item):[...sidebarState.groups,{id:crypto.randomUUID(),name,collapsed:false}];
    const saved=await saveSidebar({...sidebarState,groups});
    if(saved&&epoch===sidebarEpoch)dialog.close();else setBusy(submit,false);
  };
  dialog.showModal();input.focus();input.select();
}
function openSidebarGroupMenu(group) {
  const epoch=sidebarEpoch,dialog=sidebarDialog(group.name),rename=document.createElement("button"),remove=document.createElement("button"),cancel=document.createElement("button");
  rename.type=remove.type=cancel.type="button";rename.textContent="이름 변경";remove.textContent="그룹 삭제";cancel.textContent="닫기";
  rename.onclick=()=>{dialog.close();openSidebarGroupEditor(group);};cancel.onclick=()=>dialog.close();
  const note=document.createElement("p");note.className="sidebar-dialog-note";note.textContent="그룹을 삭제해도 대화는 유지되며 ‘그룹 없음’으로 이동합니다.";
  remove.onclick=async()=>{
    remove.disabled=true;
    const saved=await saveSidebar({...sidebarState,groups:sidebarState.groups.filter(item=>item.id!==group.id)});
    if(saved&&epoch===sidebarEpoch){for(const room of state.rooms)if(room.groupId===group.id)room.groupId=null;renderRooms();dialog.close();}
    else remove.disabled=false;
  };
  dialog.append(rename,remove,note,cancel);dialog.showModal();
}
function openRoomGroupPicker(room) {
  if(!sidebarState.loaded)return;
  const dialog=sidebarDialog("대화 그룹으로 이동"),epoch=sidebarEpoch;
  for(const group of [{id:null,name:"그룹 없음"},...sidebarState.groups]) {
    const button=document.createElement("button");button.type="button";button.className="sidebar-group-option";
    const selected=(room.groupId||null)===group.id;button.textContent=group.name+(selected?" ✓":"");button.setAttribute("aria-pressed",String(selected));
    button.onclick=async()=>{
      if(epoch!==sidebarEpoch)return;if(selected){dialog.close();return;}
      $$("button",dialog).forEach(item=>item.disabled=true);
      if(await updateRoomListPreference(room,{groupId:group.id}))dialog.close();
      else $$("button",dialog).forEach(item=>item.disabled=false);
    };dialog.append(button);
  }
  const close=document.createElement("button");close.type="button";close.textContent="취소";close.onclick=()=>dialog.close();dialog.append(close);dialog.showModal();
}
async function updateRoomListPreference(room, changes) {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;
  try {
    const prefs=await api("/api/rooms/"+room.id+"/preferences",{method:"POST",body:JSON.stringify({pinned:!!room.pinned,archived:!!room.archived,groupId:room.groupId||null,...changes})});
    if(userId!==state.session?.user?.id||epoch!==sidebarEpoch)return false;
    const current=state.rooms.find(item=>item.id===room.id);if(!current)return false;Object.assign(current,prefs);
    if(prefs.archived && state.selectedRoom===room.id) {
      const next=state.rooms.find(r=>!r.archived);
      if(next) await selectRoom(next.id); else showEmpty();
    }
    if(prefs.archived) {
      state.extra.filter(pane => pane.roomId === room.id).forEach(pane => clearAttachmentDraft(pane));
      state.extra=state.extra.filter(p=>p.roomId!==room.id);
      renderExtraPanes();
    }
    renderRooms();return true;
  } catch(error) {if(userId===state.session?.user?.id&&epoch===sidebarEpoch)toast(error.message);return false;}
}
function sidebarRoomButton(room) {
  const button=document.createElement("button");button.dataset.dockRoom=room.id;button.draggable=false;button.type="button";
  const openIds=new Set([state.selectedRoom,...state.extra.map(pane=>pane.roomId)]);button.className=`room-item ${openIds.has(room.id)?"is-active":""}`;button.dataset.roomId=room.id;
  const roomIcon=document.createElement("span");roomIcon.className="room-icon";roomIcon.append(icon("chat"));
  const copy=document.createElement("span");copy.className="room-item-copy";
  const name=document.createElement("strong");name.textContent=(room.pinned?"· ":"")+room.name;
  const meta=document.createElement("small");meta.textContent=`${room.memberCount||0}명 · ${room.description||"공동 대화"}`;
  copy.append(name,meta);button.append(roomIcon,copy);button.addEventListener("click",()=>{if(state.focusPane>0)assignExtra(state.focusPane-1,room.id);else selectRoom(room.id);closeSidebar();});return button;
}
function currentBranchId() {
  return state.focusPane > 0 ? state.extra[state.focusPane - 1]?.roomId : state.selectedRoom;
}
function branchBusy(id) {
  return branchOperations.has(id) || modelChanges.has(id) || (state.selectedRoom === id && (state.sending || state.roomData?.busy)) || state.extra.some(pane => pane.roomId === id && (pane.sending || pane.data?.busy));
}
function updateBranchControls() {
  const id = currentBranchId(), room = state.rooms.find(item => item.id === id && !item.archived), available = room && id !== MONITOR_ROOM;
  const fork = $("#branch-fork"), merge = $("#branch-merge"), label = $("#branch-current");
  if (!fork) return;
  fork.disabled = !available || branchBusy(id);
  merge.disabled = !available || branchBusy(id) || !relatedBranches(id).length;
  fork.setAttribute("aria-label", available ? `${room.name}에서 Fork` : "현재 가지에서 Fork");
  label.textContent = available ? room.name : "새 줄기에서 시작하세요";
}
function branchSvg(tag, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}
function renderRooms() {
  const focus = els.roomList.contains(document.activeElement) ? {roomId: document.activeElement.dataset.roomId, action: document.activeElement.dataset.branchAction} : null;
  renderAgentLinks(); els.roomList.replaceChildren(); updateBranchControls();
  const query = $("#room-search").value.trim().toLocaleLowerCase();
  if (showDeletedRooms) {
    const archived = state.rooms.filter(room => room.archived && room.id !== MONITOR_ROOM && [room.name, room.description].join(" ").toLocaleLowerCase().includes(query));
    for (const room of archived) {
      const row = document.createElement("div"); row.className = "branch-archive-row";
      const button = sidebarRoomButton(room), restore = document.createElement("button");
      restore.type = "button"; restore.className = "branch-restore"; restore.textContent = "복원"; restore.dataset.roomId = room.id; restore.dataset.branchAction = "restore";
      restore.setAttribute("aria-label", room.name + " 복원"); restore.onclick = () => void updateRoomListPreference(room, {archived:false});
      row.append(button, restore); els.roomList.append(row);
    }
    if (!archived.length) { const empty = document.createElement("p"); empty.className = "search-empty"; empty.textContent = "보관된 가지가 없습니다."; els.roomList.append(empty); }
  } else {
    const graph = layoutBranches(state.rooms.filter(room => room.id !== MONITOR_ROOM), state.forks, {query});
    const graphList = document.createElement("div"); graphList.className = "branch-graph";
    const width = Math.min(72, Math.max(30, graph.laneCount * 13 + 12)), step = graph.laneCount > 1 ? (width - 18) / (graph.laneCount - 1) : 0;
    graphList.style.setProperty("--branch-rail", width + "px");
    const svg = branchSvg("svg", {class:"branch-lines", width, height:graph.rows.length * 56, "aria-hidden":"true"});
    const byId = new Map(graph.rows.map(row => [row.id,row])), x = row => 9 + row.lane * step, y = row => row.index * 56 + 28;
    for (const edge of graph.edges) {
      const from = byId.get(edge.from), to = byId.get(edge.to), fromX=x(from), toX=x(to), end=y(to), start=y(from);
      const d = fromX === toX ? `M${fromX},${start}V${end}` : `M${fromX},${start}V${end-18}Q${fromX},${end} ${(fromX+toX)/2},${end}H${toX}`;
      svg.append(branchSvg("path", {d, class:`branch-path branch-color-${from.lane % 3}${edge.secondary ? " is-merge" : ""}`}));
    }
    for (const row of graph.rows) {
      const active = currentBranchId() === row.id;
      svg.append(branchSvg("circle", {cx:x(row), cy:y(row), r:active?5:3.5, class:`branch-node branch-color-${row.lane % 3}${active?" is-selected":""}`}));
      const button = document.createElement("button"); button.type="button"; button.className="branch-row"; button.dataset.roomId=row.id; button.dataset.dockRoom=row.id;
      button.classList.toggle("is-selected",active); button.classList.toggle("is-ancestor",!row.matched); if(active)button.setAttribute("aria-current","page");
      const copy=document.createElement("span"); copy.className="branch-row-copy";
      const name=document.createElement("strong"); name.textContent=(row.room.pinned?"· ":"")+row.room.name;
      const meta=document.createElement("small"), parentNames=row.parents.map(id=>byId.get(id)?.room.name).filter(Boolean);
      const relation=row.operation==="merge"?"Merge":row.operation==="fork"?"Fork":"줄기";
      meta.textContent=relation+(parentNames.length?" · "+parentNames.join(" + "):"")+(row.room.pinned?" · 고정":"");
      button.setAttribute("aria-label", `${row.room.name}, ${relation}${parentNames.length?", "+parentNames.join(" 및 ")+"에서 이어짐":""}${active?", 현재 가지":""}`);
      copy.append(name,meta); button.append(copy);
      button.onclick=()=>{if(state.focusPane>0)assignExtra(state.focusPane-1,row.id);else void selectRoom(row.id);closeSidebar();};
      graphList.append(button);
    }
    graphList.prepend(svg); els.roomList.append(graphList);
    if (!graph.rows.length) { const empty=document.createElement("p");empty.className="search-empty";empty.textContent=query?"검색 결과가 없습니다.":"+ 버튼으로 새 줄기를 시작하세요.";els.roomList.append(empty); }
  }
  const footer=document.createElement("div");footer.className="branch-list-footer";
  const trash=document.createElement("button");trash.className="deleted-rooms-toggle";trash.type="button";trash.dataset.branchAction="archive";trash.textContent=showDeletedRooms?"← 가지로 돌아가기":"보관한 가지"+(state.rooms.some(room=>room.archived)?" ("+state.rooms.filter(room=>room.archived).length+")":"");trash.onclick=()=>{showDeletedRooms=!showDeletedRooms;renderRooms();};
  const reset=document.createElement("button");reset.type="button";reset.className="branch-reset";reset.textContent="목록 비우기";reset.title="기존 가지를 보관하고 새 줄기를 시작합니다";reset.dataset.branchAction="reset";reset.onclick=()=>void resetConversations(reset);
  footer.append(trash,reset);els.roomList.append(footer);
  if(focus){const target=$$("button",els.roomList).find(button=>button.dataset.roomId===focus.roomId&&button.dataset.branchAction===focus.action);target?.focus({preventScroll:true});}
}
function showEmpty() {
  clearPendingAttachments();
  state.selectedRoom = null;
  state.roomData = null;
  desktopUI?.setRoom(null);
  stopPolling();
  els.empty.classList.remove("is-hidden");
  els.roomView.classList.add("is-hidden");
  $("#room-invite-button").classList.add("is-hidden");
  els.mobileRoomTitle.textContent = "대화를 선택하세요";
  renderRooms();
}
async function selectRoom(id) {
  if (!id) return;
  closeContextPopover();
  const previous = state.selectedRoom;
  if(previous!==id && !matchMedia("(prefers-reduced-motion: reduce)").matches) els.roomView.animate([{opacity:.35,transform:"translateY(7px)"},{opacity:1,transform:"translateY(0)"}],{duration:320,easing:"cubic-bezier(.2,.8,.2,1)"});
  state.extra.forEach((pane) => {
    if (pane.roomId === id) { clearAttachmentDraft(pane); pane.roomId = previous && previous !== id ? previous : null; }
  });
  state.selectedRoom = id;
  $("#message-input").disabled=state.sending;
  notificationUI?.markRoomRead(id);
  clearThinking(els.sendingStatus);
  const prefs = roomPreferences(id);
  $("#model-select").dataset.chosen = prefs.model || "";
  $("#effort-select").value = prefs.effort || "";
  applyModels(state.models);
  try {
    sessionStorage.setItem("community-room:" + state.session.user.id, id);
  } catch {}
  state.roomData = null;
  messageQueueUI?.render($("#composer-form"), id);
  syncProgressStreams();
  cancelActiveRecording();
  clearPendingAttachments();
  desktopUI?.setRoom(id);
  els.messages.replaceChildren();
  els.memberList.replaceChildren();
  els.memberCount.textContent = "0";
  renderRooms();
  els.empty.classList.add("is-hidden");
  els.roomView.classList.remove("is-hidden");
  const room = state.rooms.find((item) => item.id === id);
  if (room) {
    els.roomTitle.textContent = room.id===MONITOR_ROOM?"대시보드":room.name;
    els.mobileRoomTitle.textContent = room.name;
    els.roomDescription.textContent = room.description || "";
    const canInvite = room.id !== MONITOR_ROOM && room.role === "owner" && (room.sharing?.canInvite || room.sharing?.canCreateSharedCopy || !room.personal);
    els.roomKicker.textContent = room.personal ? "개인 비서 · 연결 서비스" : canInvite ? "방장" : "공동 대화";
    $("#room-invite-button").classList.toggle("is-hidden", !canInvite);
  }
  els.roomView.classList.toggle("is-host-dashboard", id === MONITOR_ROOM);
  updateBotLabel();
  if (state.layout > 1) {
    renderExtraPanes();
    refreshExtras();
  }
  await refreshRoom(true);
  startPolling();
}
function renderHostDashboard(snapshot) {
  const panel = document.createElement("section");
  panel.className = "host-dashboard";
  const element = (tag, text, className) => { const node=document.createElement(tag); node.textContent=text; if(className)node.className=className; return node; };
  panel.append(element("h2", "서버 대시보드"), element("p", "연결된 호스트 전체 사용량", "host-subtitle"));
  if (!snapshot.available || snapshot.scope !== "a1-host") {
    panel.append(element("p", "최신 서버 상태를 받지 못했습니다. 잠시 후 자동으로 다시 확인합니다.", "host-warning"));
  } else {
    const format = n => Number(n).toFixed(1);
    const cards = element("div", "", "host-cards");
    const metrics = [
      ["CPU", `${format(snapshot.cpuUsedPercent)}%`, `${snapshot.cpuCount} OCPU 전체`, snapshot.cpuUsedPercent],
      ["메모리", `${format(snapshot.memoryUsedGiB)} GiB`, `OS 사용 가능 ${format(snapshot.memoryTotalGiB)} GiB`, snapshot.memoryUsedGiB / snapshot.memoryTotalGiB * 100],
      ["전체 디스크", `${format(snapshot.diskUsedPercent)}%`, `${format(snapshot.diskUsedGiB)} / ${format(snapshot.diskTotalGiB)} GiB 사용`, snapshot.diskUsedPercent],
    ];
    for (const [label,value,detail,percent] of metrics) {
      const card=element("article", "", "host-card");
      card.append(element("h3",label),element("strong",value),element("p",detail));
      const meter=document.createElement("progress"); meter.max=100; meter.value=Math.min(100,Math.max(0,percent)); meter.setAttribute("aria-label",label+" 사용률");card.append(meter);cards.append(card);
    }
    panel.append(cards);
    const storage=element("section","","host-storage");
    storage.append(element("h3","디스크 공간"),element("p",`파일시스템 여유 ${format(snapshot.diskFreeGiB)} GiB · 미할당 ${format(snapshot.diskUnallocatedGiB)} GiB`));
    if(snapshot.diskUnallocatedGiB>1) storage.append(element("p","미할당 공간은 파티션 확장 전까지 파일 저장에 사용할 수 없습니다.","host-subtitle"));
    for (const fs of snapshot.filesystems) {
      const row=element("div","","host-filesystem");
      row.append(element("strong",fs.mount),element("span",`${format(fs.usedGiB)} / ${format(fs.totalGiB)} GiB · 여유 ${format(fs.freeGiB)} GiB`));
      if(fs.usedPercent>=85) row.append(element("span","공간 부족 주의","host-warning"));
      storage.append(row);
    }
    panel.append(storage,element("p",`최근 측정 ${new Date(snapshot.timestamp).toLocaleString('ko-KR')} · 자동 갱신`,"host-subtitle"));
  }
  els.messages.replaceChildren(panel);
}
async function refreshRoom(force = false) {
  const roomId = state.selectedRoom,
    userId = state.session?.user?.id;
  if (!roomId || (state.pollBusy && !force)) return;
  const request = ++state.roomRequest;
  state.pollBusy = true;
  const nearBottom =
    els.messages.scrollHeight -
      els.messages.scrollTop -
      els.messages.clientHeight <
    90;
  const scrollTop = els.messages.scrollTop;
  try {
    if (roomId === MONITOR_ROOM) {
      const snapshot = await api("/api/admin/monitor");
      if (state.selectedRoom === roomId && request === state.roomRequest) renderHostDashboard(snapshot);
      return;
    }
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    if (
      state.selectedRoom !== roomId ||
      state.session?.user?.id !== userId ||
      request !== state.roomRequest
    )
      return;
    const unchanged = JSON.stringify(state.roomData) === JSON.stringify(data);
    state.roomData = data;
    notificationUI?.observeRoom(data, { userId });
    observeRoomOutcome(data);
    syncProgressStreams();
    if (!unchanged) {
      renderRoom(data);
      if(nearBottom) els.messages.scrollTo({top:els.messages.scrollHeight,behavior:force?"instant":"smooth"});
      else els.messages.scrollTop=scrollTop;
    }
  } catch (error) {
    if (request !== state.roomRequest) return;
    if (error.status === 401) {
      state.session = null;
      showAuth();
    } else {
      if (error.status === 403 || error.status === 404) {
        state.roomData = null;
        syncProgressStreams();
        clearThinking(els.sendingStatus);
      }
      toast(error.message);
    }
  } finally {
    if (request === state.roomRequest) state.pollBusy = false;
  }
}
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    refreshRoom();
    refreshExtras();
  }, 3000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  stopProgressStreams();
}
function observeRoomOutcome(data) {
  const roomId=data?.room?.id; if(!roomId)return;
  const outcome=failedOutcome(data.messages);
  if(presenceTurns.has(roomId) && presenceTurns.get(roomId)!==outcome.humanId)presenceErrors.delete(roomId);
  presenceTurns.set(roomId,outcome.humanId);
  if(outcome.failed)presenceErrors.add(roomId);
  const pending=pendingMessages.get(roomId);
  if(pending && (data.messages || []).some(message=>message.id===pending.id || (pending.clientNonceHash && message.clientNonceHash===pending.clientNonceHash)))pendingMessages.delete(roomId);
}
async function optimisticMessage(roomId, text, nonce, attachments = []) {
  const user=state.session?.user;if(!user)return;
  const message={id:"pending:"+nonce,kind:"human",authorId:user.id,author:user.displayName || user.username,text,createdAt:Date.now(),attachments,pending:"sending"};
  pendingMessages.set(roomId,message);
  paintPending(roomId);
  try {
    const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(user.id+":"+nonce));
    if(pendingMessages.get(roomId)===message)message.clientNonceHash=[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
  } catch { /* POST messageId still reconciles the outbox if digest is unavailable. */ }
  return message;
}
function paintPending(roomId) {
  if(state.selectedRoom===roomId && state.roomData){renderRoom(state.roomData);els.messages.scrollTop=els.messages.scrollHeight;}
  state.extra.forEach((pane,index)=>{if(pane.roomId!==roomId)return;const list=$$(".extra-pane")[index]?.querySelector(".message-list");if(!list)return;list.replaceChildren(...mergePendingMessages(pane.data?.messages || [],pendingMessages.get(roomId)).map(message=>createMessage(message,pane,roomId)));list.scrollTop=list.scrollHeight;});
}
function renderRoom(data) {
  if(data.room) {const room=state.rooms.find(r=>r.id===data.room.id);if(room&&room.name!==data.room.name){room.name=data.room.name;els.roomTitle.textContent=room.name;renderRooms();}}
  renderContextMeter(data.context);
  messageQueueUI?.render($("#composer-form"), data.room.id, data.queue);
  const previousNodes=new Map([...els.messages.children].filter(el=>el.dataset.messageId).map(el=>[el.dataset.messageId,el]));
  els.messages.replaceChildren();
  const messages = mergePendingMessages(data.messages || [], pendingMessages.get(data.room.id));
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "message-empty";
    const title = document.createElement("strong");
    title.textContent = "아직 메시지가 없습니다.";
    const note = document.createElement("span");
    note.textContent = "메시지를 보내 대화를 시작하세요.";
    empty.append(title, note);
    els.messages.append(empty);
  } else
    messages.forEach((message) => els.messages.append((!message.pending && !previousNodes.get(message.id)?.dataset.pending ? previousNodes.get(message.id) : null) || createMessage(message, null, data.room.id)));
  const members = data.members || [];
  els.memberCount.textContent = members.length;
  els.memberList.replaceChildren();
  members.forEach((member) => {
    const row = document.createElement("div");
    row.className = "member-row";
    const avatar = document.createElement("span");
    avatar.className = `avatar ${member.role === "owner" || member.role === "admin" ? "avatar-accent" : ""}`;
    avatar.textContent = initials(member.displayName);
    const copy = document.createElement("span");
    copy.className = "member-copy";
    const name = document.createElement("strong");
    name.textContent = member.displayName;
    const role = document.createElement("small");
    role.textContent =
      member.role === "owner"
        ? "방장"
        : member.role === "admin"
          ? "관리자"
          : "멤버";
    copy.append(name, role);
    row.append(avatar, copy);
    els.memberList.append(row);
  });
  els.roomView.classList.toggle("agent-working",!!data.busy);
  if (data.busy) {
    els.messages.append(thinkingRow());
    clearThinking(els.sendingStatus);
  } else if (!state.sending) {
    clearThinking(els.sendingStatus);
  }
}
// Public execution milestones only: labels come from actual server operations.
const progressStreams = new Map();
function visibleProgressRooms() {
  const visible = new Map();
  if (state.session?.user && state.selectedRoom && state.selectedRoom !== MONITOR_ROOM && state.roomData?.busy)
    visible.set(state.selectedRoom, state.roomData);
  for (const pane of state.extra) {
    if (state.session?.user && pane.roomId && pane.data?.room?.id === pane.roomId && pane.data.busy)
      visible.set(pane.roomId, pane.data);
  }
  return visible;
}
function stopProgressStreams() {
  for (const entry of progressStreams.values()) entry.source?.close();
  progressStreams.clear();
  clearThinking(els.sendingStatus);
  updateAgentPresence();
}
function addProgress(entry, event) {
  if (!event || typeof event.stage !== "string" || typeof event.label !== "string") return;
  const milestone = { stage: event.stage, label: event.label.slice(0, 240), at: event.at };
  if (entry.events.some(item => item.stage === milestone.stage && item.label === milestone.label && item.at === milestone.at)) return;
  entry.events.push(milestone);
  if (entry.roomId && milestone.stage === "error") presenceErrors.add(entry.roomId);
  entry.events.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  entry.events = entry.events.slice(-40);
}
function refreshProgressRoom(roomId) {
  if (state.selectedRoom === roomId) void refreshRoom(true);
  state.extra.forEach((pane, index) => {
    if (pane.roomId === roomId) void refreshExtra(index);
  });
}
function syncProgressStreams() {
  const visible = visibleProgressRooms();
  for (const [roomId, entry] of progressStreams) {
    if (!visible.has(roomId)) {
      entry.source?.close();
      progressStreams.delete(roomId);
    }
  }
  for (const [roomId, data] of visible) {
    let entry = progressStreams.get(roomId);
    if (!entry) {
      entry = { roomId, events: [], source: null, retryAt: 0 };
      progressStreams.set(roomId, entry);
    }
    for (const event of Array.isArray(data.progress) ? data.progress : []) addProgress(entry, event);
    if (!entry.source && Date.now() >= entry.retryAt && typeof EventSource !== "undefined") {
      const userId = state.session?.user?.id;
      const source = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/progress`);
      entry.source = source;
      source.addEventListener("open", () => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        renderProgressRoom(roomId);
      });
      source.addEventListener("progress", event => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        try { const progress = JSON.parse(event.data); addProgress(entry, progress); notificationUI?.observeProgress(roomId, progress, { userId }); } catch { return; }
        renderProgressRoom(roomId);
      });
      source.addEventListener("done", () => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        source.close();
        entry.source = null;
        entry.retryAt = Date.now() + 3000;
        refreshProgressRoom(roomId);
      });
      source.addEventListener("error", () => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        // Recheck membership/session through the API; polling controls bounded retries.
        source.close();
        entry.source = null;
        entry.retryAt = Date.now() + 6000;
        renderProgressRoom(roomId);
        refreshProgressRoom(roomId);
      });
    }
    renderProgressRoom(roomId);
  }
  updateAgentPresence();
}
function renderProgressRoom(roomId) {
  updateAgentPresence();
  for (const target of $$("[data-progress-room]")) {
    if (target.dataset.progressRoom === roomId) renderProgressTarget(target, roomId);
  }
}
function updateAgentPresence() {
  const rooms = [{ roomId: state.selectedRoom, data: state.roomData }, ...state.extra.map(pane => ({ roomId: pane.roomId, data: pane.data?.room?.id === pane.roomId ? pane.data : null }))].filter(room => room.roomId && room.roomId !== MONITOR_ROOM);
  agentPresence?.set(resolveAgentPresence({
    sending: state.sending || state.extra.some(pane => pane.sending),
    rooms: rooms.map(room => ({ busy: !!room.data?.busy, stage: (progressStreams.get(room.roomId)?.events || room.data?.progress || []).at(-1)?.stage })),
    hasError: rooms.some(room => presenceErrors.has(room.roomId)),
  }), Boolean(state.session?.user));
}
function renderProgressTarget(target, roomId) {
  const entry = progressStreams.get(roomId);
  const events = entry?.events || [];
  const label = events.at(-1)?.label || "진행 상황을 연결하는 중";
  const line = $(".think-line", target);
  if (line && line.textContent !== label) line.textContent = label;
}
function thinkParts() {
  const mark = document.createElement("span");
  mark.className = "think-mark";
  mark.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i += 1) mark.append(document.createElement("i"));
  const line = document.createElement("span");
  line.className = "think-line";
  const caret = document.createElement("span");
  caret.className = "think-caret";
  caret.setAttribute("aria-hidden", "true");
  return [mark, line, caret];
}
function showThinking(target, fixed, roomId = state.selectedRoom) {
  target.replaceChildren();
  target.classList.add("is-visible");
  const [mark, line, caret] = thinkParts();
  target.append(mark, line, caret);
  if (fixed) {
    delete target.dataset.progressRoom;
    line.textContent = fixed;
  } else {
    target.dataset.progressRoom = roomId;
    renderProgressTarget(target, roomId);
  }
}
function clearThinking(target) {
  target.replaceChildren();
  target.classList.remove("is-visible");
  delete target.dataset.progressRoom;
}
function thinkingRow(roomId = state.selectedRoom) {
  const article = document.createElement("article");
  article.className = "message message-bot message-thinking";
  article.setAttribute("aria-label", "에이전트 진행 상황");
  const body = document.createElement("div");
  body.className = "message-body";
  const bubble = document.createElement("div");
  bubble.className = "think-bubble";
  bubble.dataset.progressRoom = roomId;
  bubble.append(...thinkParts());
  renderProgressTarget(bubble, roomId);
  body.append(bubble);
  article.append(body);
  return article;
}
const animatedMessages = new Set();
function createMessage(message, pane = null, roomId = state.selectedRoom) {
  const article = document.createElement("article");
  if(message.id)article.dataset.messageId=message.id;
  if(message.pending)article.dataset.pending=message.pending;
  const own =
    message.kind === "human" && message.authorId === state.session?.user?.id;
  article.className = `message message-${message.kind}${own ? " message-own" : ""}`;
  if(message.id && Date.now()-message.createdAt<15000 && !animatedMessages.has(message.id)){article.classList.add("message-enter");animatedMessages.add(message.id);if(animatedMessages.size>500)animatedMessages.delete(animatedMessages.values().next().value);}
  const avatar = document.createElement("div");
  avatar.className = `avatar ${message.kind === "bot" ? "avatar-bot" : ""}`;
  if (message.kind !== "bot") avatar.textContent = initials(message.author);
  const body = document.createElement("div");
  body.className = "message-body";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("strong");
  author.textContent =
    message.author || (message.kind === "system" ? "안내" : "알 수 없음");
  const time = document.createElement("time");
  time.textContent = new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(message.createdAt));
  time.dateTime = new Date(message.createdAt).toISOString();
  time.title = formatDate(message.createdAt);
  meta.append(author, time);
  if (message.text) {
    const text = message.kind === "bot" ? renderMessageText(message.text) : document.createElement("p");
    if(message.kind !== "bot")text.textContent = message.text;
    body.append(text);
  }
  if (Array.isArray(message.attachments)) {
    const attachments = document.createElement("div");
    attachments.className = "message-attachments";
    message.attachments.forEach((attachment) => {
      if (!attachment || !attachment.url) return;
      if (attachment.kind === "image") {
        const image = document.createElement("img");
        image.src = attachment.url;
        image.alt = attachment.name || "첨부 이미지";
        image.loading = "lazy";
        image.addEventListener("click", () => {
          $("#image-dialog-image").src = attachment.url;
          $("#image-dialog-image").alt = attachment.name || "첨부 이미지";
          openDialog($("#image-dialog"));
        });
        attachments.append(image);
      } else if (attachment.kind === "audio") {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = attachment.url;
        audio.setAttribute("aria-label", attachment.name || "첨부 음성");
        attachments.append(audio);
      }
    });
    if (attachments.childElementCount) body.append(attachments);
  }
  if (message.kind !== "bot") article.append(avatar);
  if (!message.pending && roomId !== MONITOR_ROOM && message.id) {
    const actions = document.createElement("div"); actions.className = "message-actions";
    const copy = document.createElement("button"); copy.type = "button"; copy.append(icon("copy")); copy.title = "메시지 복사"; copy.setAttribute("aria-label", copy.title);
    copy.onclick = () => navigator.clipboard.writeText(message.text || "").then(() => toast("복사했습니다.")).catch(() => toast("복사하지 못했습니다."));
    const fork = document.createElement("button"); fork.type = "button"; fork.append(icon("fork")); fork.title = "여기서 포크 · 이 메시지까지를 줄기로 새 가지를 만듭니다"; fork.setAttribute("aria-label", "여기서 포크");
    fork.onclick = () => sessionAction("fork", pane, fork, message.id, roomId);
    actions.append(copy, fork); body.append(actions);
  }
  if (message.pending === "failed") { const note=document.createElement("p");note.className="message-send-error";note.textContent="전송을 확인하지 못했어요. 입력창에서 다시 시도해 주세요.";body.append(note); }
  article.append(body);
  return article;
}
function renderBotPicker() {
  const picker = $("#bot-picker");
  picker.replaceChildren();
  if (!state.bots.length) {
    const note = document.createElement("span");
    note.className = "picker-note";
    note.textContent = "사용 가능한 봇이 없습니다.";
    picker.append(note);
    return;
  }
  state.bots.forEach((bot) => {
    const label = document.createElement("label");
    label.className = "bot-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = bot.id;
    checkbox.checked = state.selectedBots.includes(bot.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked && state.selectedBots.length >= 3) {
        checkbox.checked = false;
        toast("한 번에 최대 3개의 봇을 선택할 수 있어요.");
        return;
      }
      state.selectedBots = $$(".bot-option input:checked", picker).map(
        (input) => input.value,
      );
      state.botChoiceTouched = true;
      updateBotLabel();
    });
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = bot.name;
    const desc = document.createElement("small");
    desc.textContent = bot.description || "";
    copy.append(name, desc);
    label.append(checkbox, copy);
    picker.append(label);
  });
  updateBotLabel();
}
function updateBotLabel() {
  $("#bot-picker-label").textContent = "";
  $("#bot-picker-label").hidden = true;
}

function clearPendingAttachments(pane = null) {
  clearAttachmentDraft(pane || state);
  renderPendingAttachments(pane);
}
function cancelActiveRecording() {
  if (!state.recording) return;
  state.recordingCancelled = true;
  try { state.recording.stop(); } catch {}
}
function renderPendingAttachments(pane = null) {
  const owner = pane || state;
  const section = pane ? $$(".extra-pane")[state.extra.indexOf(pane)] : null;
  const list = pane ? section && $(".attachment-list", section) : $("#attachment-list");
  if (!list) return;
  list.replaceChildren();
  (owner.pendingAttachments || []).forEach((item) => {
    const card = document.createElement("div");
    card.className = `attachment-card${item.error ? " is-error" : ""}`;
    if (item.kind === "image" && item.previewUrl) {
      const image = document.createElement("img");
      image.src = item.previewUrl;
      image.alt = item.name;
      card.append(image);
    } else if (item.kind === "audio" && item.previewUrl && !item.error) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = item.previewUrl;
      card.append(audio);
    }
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = item.error || (item.uploading ? `${item.name} · 업로드 중…` : item.name);
    card.append(name);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", `${item.name} 첨부 제거`);
    remove.disabled = !!owner.sending;
    remove.append(icon("close"));
    remove.addEventListener("click", () => {
      if (owner.sending) return;
      removeAttachmentDraft(owner, item);
      renderPendingAttachments(pane);
    });
    card.append(remove);
    list.append(card);
  });
}
async function uploadAttachments(files, pane = null) {
  if (composerBlocked(pane)) return;
  const owner = pane || state;
  const roomId = pane ? pane.roomId : state.selectedRoom;
  const userId = state.session?.user?.id;
  return uploadAttachmentFiles({
    files, owner, roomId,
    isCurrent: () => !!userId && state.session?.user?.id === userId &&
      (pane ? state.extra.includes(pane) && pane.roomId === roomId : state.selectedRoom === roomId),
    changed: () => renderPendingAttachments(pane),
    notify: toast,
    upload: (file, name, signal) => {
      const form = new FormData();
      form.append("file", file, name);
      return api(`/api/rooms/${encodeURIComponent(roomId)}/attachments`, { method: "POST", body: form, signal });
    },
  });
}
function pasteAttachments(event, pane = null) {
  pasteComposerImages(event, { enabled: !composerBlocked(pane), upload: files => uploadAttachments(files, pane) });
}
async function toggleRecording() {
  if (voiceUI?.roomId) { toast("통화가 끝난 뒤 녹음을 첨부할 수 있어요."); return; }
  const button = $("#record-button");
  if (state.recordingPending) return;
  if (state.recording) {
    state.recording.stop();
    button.disabled = true;
    button.textContent = "처리 중…";
    return;
  }
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    toast("이 브라우저에서는 음성 녹음을 사용할 수 없어요. 음성 파일을 첨부해주세요.");
    return;
  }
  const roomId = state.selectedRoom;
  const attachmentGeneration = state.attachmentGeneration;
  state.recordingPending = true;
  button.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    state.recordingPending = false;
    button.disabled = false;
    toast(error?.name === "NotAllowedError" ? "마이크 권한이 필요합니다." : "마이크를 사용할 수 없습니다.");
    return;
  }
  if (roomId !== state.selectedRoom || attachmentGeneration !== state.attachmentGeneration) {
    stream.getTracks().forEach((track) => track.stop());
    state.recordingPending = false;
    button.disabled = false;
    return;
  }
  const chunks = [];
  let recordedBytes = 0;
  let tooLarge = false;
  let recorder;
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported?.(type));
  try { recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); } catch {
    stream.getTracks().forEach((track) => track.stop());
    state.recordingPending = false;
    button.disabled = false;
    toast("이 브라우저에서 지원하는 녹음 형식이 없습니다.");
    return;
  }
  state.recording = recorder;
  state.recordingPending = false;
  state.recordingCancelled = false;
  button.classList.add("is-recording");
  $("#record-cancel-button").hidden = false;
  button.setAttribute("aria-label", "음성 녹음 중지");
  button.title = "녹음 중지";
  recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
  recorder.addEventListener("dataavailable", (event) => {
    recordedBytes += event.data.size;
    if (recordedBytes > 12 * 1024 * 1024 && recorder.state === "recording") {
      tooLarge = true;
      state.recordingCancelled = true;
      recorder.stop();
      toast("녹음이 12MB에 도달해 중지되었습니다.");
    }
  });
  recorder.addEventListener("error", () => {
    state.recordingCancelled = true;
    tooLarge = false;
    stream.getTracks().forEach((track) => track.stop());
    toast("음성 녹음 중 오류가 발생했습니다.");
    if (recorder.state === "recording") {
      try { recorder.stop(); } catch {}
    }
  });
  recorder.addEventListener("stop", async () => {
    clearTimeout(recorder.timeout);
    stream.getTracks().forEach((track) => track.stop());
    state.recording = null;
    const cancelled = state.recordingCancelled;
    state.recordingCancelled = false;
    $("#record-cancel-button").hidden = true;
    button.disabled = false;
    button.classList.remove("is-recording");
    button.textContent = "";
    button.append(icon("mic"));
    button.setAttribute("aria-label", "음성 녹음 시작");
    button.title = "음성 녹음";
    if (cancelled || tooLarge || !chunks.length) return;
    if (roomId !== state.selectedRoom || attachmentGeneration !== state.attachmentGeneration) return;
    const extension = recorder.mimeType.includes("mp4") ? "mp4" : recorder.mimeType.includes("ogg") ? "ogg" : "webm";
    await uploadAttachments([new File([new Blob(chunks, { type: recorder.mimeType })], `voice-${Date.now()}.${extension}`, { type: recorder.mimeType })]);
  });
  recorder.start(1000);
  button.disabled = false;
  recorder.timeout = setTimeout(() => {
    if (recorder.state === "recording") {
      recorder.stop();
      toast("녹음은 최대 120초까지 가능합니다.");
    }
  }, 120000);
  toast("녹음 중… 다시 눌러 녹음을 첨부합니다.");
}
function topicChoiceDialog() {
  return new Promise(resolve=>{
    const dialog=sidebarDialog("다른 일을 시작하시나요?");dialog.classList.add("topic-choice-dialog");
    const note=document.createElement("p");note.textContent="이전 내용을 이어서 가지치기할까요, 아예 새 대화로 시작할까요?";
    const choices=document.createElement("div");choices.className="topic-choice-buttons";
    let answer="cancel";
    for(const [value,title,description] of [["fork","이전 내용 이어서","지금까지의 내용을 가지고 새 가지에서 시작해요."],["new","새로 시작","이전 내용 없이 빈 대화에서 시작해요."],["stay","여기서 계속","현재 대화에 그대로 보내요."]]) {
      const button=document.createElement("button");button.type="button";
      const label=document.createElement("strong"),detail=document.createElement("span");label.textContent=title;detail.textContent=description;button.append(label,detail);
      button.onclick=()=>{answer=value;dialog.close();};choices.append(button);
    }
    const cancel=document.createElement("button");cancel.type="button";cancel.textContent="취소";cancel.onclick=()=>dialog.close();
    dialog.append(note,choices,cancel);dialog.addEventListener("close",()=>resolve(answer),{once:true});dialog.showModal();choices.firstChild.focus();
  });
}
// A conservative local suggestion keeps ordinary sends instant and never changes a room by itself.
async function offerTopicChoice(pane,draft) {
  const {roomId,data}=roomContextOwner(pane),userId=state.session?.user?.id;
  if(data?.busy || !data || data.room?.pendingTitle || roomId===MONITOR_ROOM || !suggestTopicSwitch({history:data.messages,draft}).suggest)return false;
  topicPrompts.add(roomId);
  const model=pane?.model??$("#model-select").value,effort=pane?.effort??$("#effort-select").value;
  const current=()=>contextOwnerCurrent(roomId,userId,pane);
  const sourceInput=pane?$("textarea",$$(".extra-pane")[state.extra.indexOf(pane)]):$("#message-input");
  let locked=false,lockedRoomId=roomId;
  try {
    const choice=await topicChoiceDialog();
    if(!current()||choice==="cancel")return true;
    if(choice==="stay")return false;
    if(roomContextOwner(pane).busy){toast("답변이 끝난 뒤 다시 보내 주세요.");return true;}
    sourceInput.disabled=true;locked=true;
    const result=await api(choice==="fork"?`/api/rooms/${encodeURIComponent(roomId)}/fork`:"/api/rooms",{method:"POST",body:"{}"});
    if(!current())return true;
    saveRoomPreferences(result.room.id,{model,effort});
    await loadRooms();if(!current())return true;
    if(pane){
      const index=state.extra.indexOf(pane);assignExtra(index,result.room.id);pane.model=model;pane.effort=effort;pane.draft=draft;
      const form=$(".pane-composer",$$(".extra-pane")[index]);$("textarea",form).value=draft;
      await submitPane({preventDefault(){},currentTarget:form},index,true);
    }else{
      lockedRoomId=result.room.id;
      await selectRoom(result.room.id);if(!contextOwnerCurrent(result.room.id,userId))return true;
      $("#message-input").value=draft;await submitMessage({preventDefault(){}},true);
    }
    return true;
  }catch(error){if(current())toast(error.message);return true;}
  finally{topicPrompts.delete(roomId);if(locked&&sourceInput.isConnected&&contextOwnerCurrent(lockedRoomId,userId,pane))sourceInput.disabled=false;}
}
async function submitMessage(event, skipTopic = false) {
  event.preventDefault();
  if (composerBlocked()) return;
  const input = $("#message-input"),
    text = input.value.trim();
  const attachments = state.pendingAttachments.filter((item) => item.attachment && !item.error);
  const attachmentGeneration = state.attachmentGeneration;
  const roomId = state.selectedRoom,
    botIds = [...state.selectedBots];
  if (state.pendingAttachments.some((item) => item.uploading)) {
    toast("첨부 파일 업로드가 끝날 때까지 기다려주세요.");
    return;
  }
  if (state.pendingAttachments.some(item => item.error)) { toast("업로드하지 못한 첨부 파일을 제거한 뒤 다시 첨부해 주세요."); return; }
  if (!text && !attachments.length) return;
  if(topicPrompts.has(roomId))return;
  if(!skipTopic && !attachments.length && await offerTopicChoice(null,text))return;
  if(state.selectedRoom!==roomId || composerBlocked())return;
  const attachmentIds = attachments.map((item) => item.attachment.id);
  const model = $("#model-select").value, effort = $("#effort-select").value;
  const signature = JSON.stringify({ roomId, text, botIds, attachmentIds, model, effort });
  if (state.pendingSend?.signature !== signature)
    state.pendingSend = { signature, nonce: crypto.randomUUID() };
  const payload = JSON.stringify({
    text,
    botIds,
    attachmentIds,
    clientNonce: state.pendingSend.nonce,
    model,
    effort,
    queueIfBusy: true,
  });
  const sendUserId=state.session?.user?.id;
  presenceErrors.delete(roomId);
  state.sending = true;
  updateModelAvailability();
  $("#send-button").disabled = true;
  input.disabled = true;
  input.value=""; input.style.height="";
  const pending = state.roomData?.busy ? null : await optimisticMessage(roomId,text,state.pendingSend.nonce,attachments.map(item=>item.attachment));
  let accepted=false;
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: payload,
      retryable: true,
    });
    accepted=true;
    if(state.session?.user?.id!==sendUserId)return;
    if(result.queued && pendingMessages.get(roomId)===pending)pendingMessages.delete(roomId);
    if(result.messageId && pending)pending.id=result.messageId;
    if(result.queued)paintPending(roomId);
    if (Array.isArray(result.models)) applyModels(result.models);
    state.pendingSend = null;
    if(state.selectedRoom===roomId && state.attachmentGeneration===attachmentGeneration)clearPendingAttachments();
    await refreshRoom(true);
    await loadRooms();
  } catch (error) {
    if(state.session?.user?.id!==sendUserId)return;
    if(accepted){toast("메시지는 접수됐습니다. 대화를 다시 불러오고 있어요.");return;}
    presenceErrors.add(roomId);
    if(pending)pending.pending="failed";
    if(state.selectedRoom===roomId && !input.value)input.value=text;
    paintPending(roomId);toast(error.message);
  } finally {
    if(state.session?.user?.id!==sendUserId)return;
    state.sending = false;
    $("#send-button").disabled = false;
    input.disabled = false;
    if (!state.roomData?.busy) clearThinking(els.sendingStatus);
    if(state.selectedRoom===roomId)input.focus();
    updateModelAvailability();
  }
}
async function authSubmit(event, endpoint, buttonLabel) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const message = els.authMessage;
  showMessage(message, "");
  setBusy(button, true, "확인 중…");
  try {
    state.session = await api(endpoint, {
      method: "POST",
      body: JSON.stringify(formDataObject(form)),
    });
    if (endpoint === "/api/register") inviteLinks.clear("site");
    form.reset();
    await enterWorkspace();
  } catch (error) {
    showMessage(message, error.message);
  } finally {
    setBusy(button, false, buttonLabel);
  }
}
function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
  const first = dialog.querySelector(
    "input:not([hidden]), textarea:not([hidden]), button:not(.modal-close)",
  );
  setTimeout(() => first?.focus(), 0);
}
function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}
let creatingSession=false;
async function startNewSession() {
  if(creatingSession)return;creatingSession=true;
  const userId=state.session?.user?.id,epoch=sidebarEpoch,current=()=>state.session?.user?.id===userId&&sidebarEpoch===epoch;
  try {const data=await api("/api/rooms",{method:"POST",body:JSON.stringify({})});if(!current())return;await loadRooms();if(!current())return;state.focusPane=0;await selectRoom(data.room.id);$("#message-input").focus();}
  catch(error){if(current())toast(error.message);}finally{creatingSession=false;}
}
async function resetConversations(button, dialog = null) {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId||button.disabled)return;
  if(state.rooms.some(room=>branchBusy(room.id))){toast("진행 중인 작업이 끝난 뒤 목록을 비워 주세요.");return;}
  setBusy(button,true,"비우는 중…");
  try {
    const data=await api("/api/sessions/reset",{method:"POST",body:"{}"});
    if(state.session?.user?.id!==userId||sidebarEpoch!==epoch)return;
    dialog?.close();stopProgressStreams();if(state.layout>1)setLayout(state.layout);
    dockRects=[{x:0,y:0,w:1,h:1}];applyDockLayout();showDeletedRooms=false;$("#room-search").value="";$("#message-input").value="";state.pendingSend=null;pendingMessages.clear();clearPendingAttachments();
    await loadRooms();if(state.session?.user?.id!==userId||sidebarEpoch!==epoch)return;await selectRoom(data.room.id);
    toast(`${data.archived||0}개 가지를 보관하고 새 줄기를 시작했습니다.`);
  } catch(error){if(state.session?.user?.id===userId&&sidebarEpoch===epoch)toast(error.message);}
  finally{if(button.isConnected)setBusy(button,false);}
}
async function openCapabilityHub() {
  let dialog=$("#capability-hub");
  if(!dialog){dialog=document.createElement("dialog");dialog.id="capability-hub";dialog.className="capability-hub";document.body.append(dialog);}
  dialog.replaceChildren();
  const title=document.createElement("h2");title.textContent="통합 관리";
  const close=document.createElement("button");close.textContent="닫기";close.onclick=()=>dialog.close();dialog.append(title,close);
  const sessions=document.createElement("section"), sessionTitle=document.createElement("h3"), sessionNote=document.createElement("p"), reset=document.createElement("button");
  sessionTitle.textContent="대화 세션";
  sessionNote.textContent="내 대화 목록을 비우고 새 세션을 시작합니다. 기존 기록은 ‘삭제한 대화’에서 복원할 수 있습니다.";
  reset.textContent="대화 목록 초기화";
  reset.onclick=()=>void resetConversations(reset,dialog);
  sessions.append(sessionTitle,sessionNote,reset);dialog.append(sessions);dialog.showModal();
  try {
    const data=await api("/api/admin/capabilities");
    for(const [name,items] of [["API",[...new Set(data.providers.map(p=>p.name))]],["Vault",data.services.map(s=>`${s.name} · ${s.configured?"키 등록됨":"미등록"}`)],["MCP",["연결된 MCP 서버 없음"]],["스킬",["실행 연결된 스킬 없음"]]]) {
      const section=document.createElement("section"),h=document.createElement("h3");h.textContent=name;section.append(h);
      for(const text of items){const row=document.createElement("p");row.textContent=text;section.append(row);}dialog.append(section);
    }
    const note=document.createElement("p");note.textContent=data.note;dialog.append(note);
  }catch(error){const note=document.createElement("p");note.textContent=error.message;dialog.append(note);}
}
const modelChanges = new Map();
function roomContextOwner(pane = null) {
  const roomId=pane?pane.roomId:state.selectedRoom,data=pane?pane.data:state.roomData;
  const working=!!(data?.busy||(pane?pane.sending:state.sending));
  const role=data?.room?.role || state.rooms?.find(room=>room.id===roomId)?.role;
  return {roomId,data,working,busy:working||modelChanges.has(roomId)||branchOperations.has(roomId),canManage:role==="owner"};
}
function contextOwnerCurrent(roomId, userId, pane = null) {
  return state.session?.user?.id === userId && (pane ? state.extra.includes(pane) && pane.roomId === roomId : state.selectedRoom === roomId);
}
async function refreshContextOwner(pane) {
  if (pane) await refreshExtra(state.extra.indexOf(pane));
  else await refreshRoom(true);
}
function relatedBranches(roomId) {
  return relatedBranchIds(roomId, state.rooms.filter(room=>room.id!==MONITOR_ROOM), state.forks).map(id=>state.rooms.find(room=>room.id===id));
}
function branchDestination(pane = null, explicit = false) {
  const target = explicit && state.focusPane > 0 ? state.extra[state.focusPane-1] : pane;
  const selection = state.selectedRoom, focused=state.focusPane, targetId=target?.roomId, userId=state.session?.user?.id, epoch=sidebarEpoch;
  return {pane:target,userId,valid:()=>state.session?.user?.id===userId&&sidebarEpoch===epoch,current:()=>state.session?.user?.id===userId&&sidebarEpoch===epoch&&state.selectedRoom===selection&&state.focusPane===focused&&(!target||(state.extra.includes(target)&&target.roomId===targetId))};
}
async function openBranchResult(data, destination) {
  await loadRooms(); if(!destination.current())return;
  showDeletedRooms=false;$("#room-search").value="";
  if(destination.pane)assignExtra(state.extra.indexOf(destination.pane),data.room.id);else await selectRoom(data.room.id);
  renderRooms();closeSidebar();
  toast(data.contextTruncated?"맥락이 길어 일부만 이어받았습니다. 원본 가지에서 전체 기록을 볼 수 있어요.":"새 가지를 만들었습니다. 원본은 그대로 남습니다.");
}
function mergeBranch(roomId) {
  const room=state.rooms.find(item=>item.id===roomId&&!item.archived), branches=relatedBranches(roomId);
  if(!room||branchBusy(roomId))return;
  if(!branches.length){toast("합칠 가지가 없습니다. 먼저 Fork로 가지를 만들어 주세요.");return;}
  const destination=branchDestination(null,true),dialog=sidebarDialog("가지 Merge"),form=document.createElement("form");dialog.classList.add("branch-merge-dialog");
  const note=document.createElement("p");note.className="sidebar-dialog-note";note.textContent="두 가지의 현재 맥락으로 새 가지를 만듭니다. 원본 가지는 유지됩니다.";
  const label=document.createElement("label");label.textContent="함께 이어갈 가지";
  const select=document.createElement("select");select.required=true;
  for(const branch of branches){const option=document.createElement("option");option.value=branch.id;option.textContent=branch.name+" · "+branch.id.slice(0,8);option.disabled=branchBusy(branch.id);select.append(option);}
  const first=branches.find(branch=>!branchBusy(branch.id));select.value=first?.id||"";label.append(select);
  const preview=document.createElement("p");preview.className="branch-merge-preview";
  const error=document.createElement("p");error.className="form-message";error.setAttribute("role","status");
  const actions=document.createElement("div");actions.className="sidebar-dialog-actions";
  const cancel=document.createElement("button");cancel.type="button";cancel.textContent="취소";cancel.onclick=()=>dialog.close();
  const submit=document.createElement("button");submit.type="submit";submit.textContent="새 가지로 Merge";submit.disabled=!first;
  const update=()=>{preview.textContent=room.name+" + "+(branches.find(branch=>branch.id===select.value)?.name||"가지 선택")+" → 새 가지";};select.onchange=update;update();
  actions.append(cancel,submit);form.append(note,label,preview,error,actions);dialog.append(form);
  form.onsubmit=async event=>{
    event.preventDefault();const sourceId=select.value;
    if(submit.disabled||!destination.valid()||!relatedBranches(roomId).some(branch=>branch.id===sourceId))return;
    if(branchBusy(roomId)||branchBusy(sourceId)){error.textContent="진행 중인 작업이 끝난 뒤 합쳐 주세요.";return;}
    branchOperations.add(roomId);branchOperations.add(sourceId);select.disabled=true;submit.disabled=true;updateModelAvailability();
    try{const data=await api(`/api/rooms/${encodeURIComponent(roomId)}/merge`,{method:"POST",body:JSON.stringify({sourceId})});if(!destination.valid())return;const follow=dialog.open;dialog.close();if(follow)await openBranchResult(data,destination);else await loadRooms();}
    catch(e){if(destination.valid()&&dialog.open)error.textContent=e.message;}
    finally{if(destination.valid()){branchOperations.delete(roomId);branchOperations.delete(sourceId);select.disabled=false;submit.disabled=false;updateModelAvailability();}}
  };
  dialog.showModal();select.focus();
}
async function sessionAction(action, pane = null, button = null, throughMessageId = null, expectedRoomId = null, explicitRoomId = null) {
  const owner=roomContextOwner(pane),roomId=explicitRoomId||owner.roomId,destination=branchDestination(pane,!!explicitRoomId);
  if(!roomId||roomId===MONITOR_ROOM||branchBusy(roomId)||(expectedRoomId&&expectedRoomId!==roomId)||!state.rooms.some(room=>room.id===roomId&&!room.archived))return;
  if(action==="compact"&&!owner.canManage)return;
  if(button)button.disabled=true;branchOperations.add(roomId);updateModelAvailability();
  try {
    const data=await api(`/api/rooms/${encodeURIComponent(roomId)}/${action}`,{method:"POST",body:JSON.stringify(throughMessageId?{throughMessageId}:{})});
    if(!destination.valid())return;
    if(action==="fork")await openBranchResult(data,destination);
    else if(destination.current()){await refreshContextOwner(pane);toast("기록은 보존하고 대화 맥락을 압축했습니다.");}
  }catch(error){if(destination.valid())toast(error.message);}
  finally{if(destination.valid()){branchOperations.delete(roomId);if(button?.isConnected)button.disabled=branchBusy(roomId);updateModelAvailability();}}
}
function contextNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value.toLocaleString("ko-KR") : "확인 불가";
}
function contextPercent(context) {
  return Math.min(100,Math.max(0,Math.round((context?.usedChars||0)/(context?.budgetChars||8000)*100)));
}
function contextElement(tag, text, className) {
  const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;
}
function renderContextMeter(context, form = $("#composer-form"), pane = null) {
  if(!form)return;
  const toolbar=$(".model-controls",form);
  if(!toolbar)return;
  let bar=$(".context-controls",form);
  if(!bar) {
    bar=contextElement("div",undefined,"context-controls");
    const trigger=contextElement("button",undefined,"context-trigger");trigger.type="button";trigger.setAttribute("aria-label","컨텍스트 및 API 사용량");trigger.setAttribute("aria-haspopup","dialog");trigger.setAttribute("aria-expanded","false");
    const ring=contextElement("span",undefined,"context-ring"),label=contextElement("span",undefined,"context-label");ring.setAttribute("aria-hidden","true");label.setAttribute("aria-hidden","true");trigger.append(ring,label);trigger.onclick=()=>openContextPopover(trigger,pane);
    bar.append(trigger);toolbar.append(bar);
    if(!pane){bar.id="context-controls";trigger.id="context-usage-button";ring.id="context-ring";label.id="context-label";}
  }
  const percent=contextPercent(context), owner=roomContextOwner(pane);
  $(".context-ring",bar).style.setProperty("--context",percent+"%");
  $(".context-label",bar).textContent=percent+"%";
  bar.removeAttribute("title");
  $(".context-trigger",bar).disabled=!owner.roomId;
  if(contextPopover?.roomId===owner.roomId){renderPopoverContext(contextPopover.contextSection,context);contextPopover.compact.disabled=owner.busy||!owner.canManage||!(context?.usedChars>=500);}
  updateModelAvailability();
}
let contextPopover = null;
function closeContextPopover() {
  const open=contextPopover;if(!open)return;contextPopover=null;
  open.cancelled=true;open.abort.abort();open.trigger.setAttribute("aria-expanded","false");
  window.removeEventListener("resize",open.position);window.removeEventListener("scroll",open.position,true);
  try {if(open.native)open.element.hidePopover();else if(open.element.open)open.element.close();} catch {}
  open.element.remove();
}
function renderPopoverContext(section, context) {
  section.replaceChildren();
  const heading=contextElement("h3","Context window"),amount=contextElement("strong",`${contextPercent(context)}%`,"context-popover-percent");
  const top=contextElement("div",undefined,"context-section-heading");top.append(heading,amount);
  const meter=document.createElement("progress");meter.max=100;meter.value=contextPercent(context);meter.setAttribute("aria-label","앱 대화 맥락 추정 사용률");
  const scale=contextElement("div",undefined,"context-scale");
  const budget=Math.round((context?.budgetChars||8000)/2);
  for(const fraction of [0,.25,.5,.75,1])scale.append(contextElement("span",contextNumber(Math.round(budget*fraction))));
  const tokens=contextElement("p",`약 ${contextNumber(context?.estimatedTokens)} / ${contextNumber(Math.round((context?.budgetChars||8000)/2))} 토큰 · 추정`,"context-muted");
  const breakdown=contextElement("div",undefined,"context-breakdown");
  for(const [label,value] of [["최근 대화",context?.messageTokens],["압축 요약",context?.summaryTokens]]) {
    const row=contextElement("div");row.append(contextElement("span",label),contextElement("span",`${contextNumber(value)} 토큰`));breakdown.append(row);
  }
  section.append(top,meter,scale,tokens,breakdown,contextElement("p","앱이 다음 요청에 담는 대화 범위입니다. 시스템 지시·도구·이미지와 모델 전체 컨텍스트 창은 제외됩니다.","context-note"));
}
function usageTime(value) {
  const date=new Date(value);return value!=null&&!Number.isNaN(date.getTime())?date.toLocaleString("ko-KR",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}):"시각 확인 불가";
}
function renderUsageSection(section, usage) {
  section.replaceChildren(contextElement("h3","이 대화의 API 기록"));
  const counts=contextElement("div",undefined,"context-usage-counts");
  for(const [label,value] of [["입력 토큰",usage.inputTokens],["출력 토큰",usage.outputTokens],["API 응답",usage.requests]]) {
    const item=contextElement("div");item.append(contextElement("strong",contextNumber(value)),contextElement("span",label));counts.append(item);
  }
  section.append(counts);
  if(usage.last) section.append(contextElement("p",`최근 ${usage.last.provider || "공급자 미제공"} · ${usage.last.model || "모델 미제공"}`,"context-note"));
  else section.append(contextElement("p","기록된 API 호출이 없습니다.","context-note"));
  const providers=(Array.isArray(usage.providers)?[...usage.providers]:[]).sort((a,b)=>new Date(b.at)-new Date(a.at));
  if(providers.length) {
    const quota=contextElement("section",undefined,"context-quota");quota.append(contextElement("h3","공급자 한도"));
    const selector=contextElement("select",undefined,"context-provider-select");selector.setAttribute("aria-label","공급자와 API 키 선택");
    providers.forEach((provider,index)=>{
      const slot=Number.isInteger(provider.keySlot)?provider.keySlot+1:"확인 불가";
      selector.append(new Option(`${provider.provider || "공급자"} · 키 ${slot}`,String(index)));
    });
    const values=contextElement("div");
    function showProvider() {
      const provider=providers[Number(selector.value)||0],groq=String(provider.provider).toLowerCase()==="groq";
      values.replaceChildren(contextElement("p",`${usageTime(provider.at)} 기준${groq?" · 조직 공유":""}`,"context-note"));
      for(const [key,label] of [["requests","요청"],["tokens","토큰"]]) {
        const limit=provider.limits?.[key],row=contextElement("div",undefined,"context-quota-row");
        const value=limit?`${contextNumber(limit.remaining)} / ${contextNumber(limit.limit)} 남음`:"공급자 미제공";
        row.append(contextElement("span",label+(groq?(key==="requests"?" / 일":" / 분"):"")),contextElement("span",value));values.append(row);
        if(limit?.reset!=null)values.append(contextElement("p",`갱신: ${String(limit.reset).slice(0,100)}`,"context-note"));
      }
      contextPopover?.position();
    }
    selector.onchange=showProvider;showProvider();quota.append(selector,values);section.append(quota);
  }
  const scope=contextElement("details",undefined,"context-scope-note");scope.append(contextElement("summary","집계 기준"));
  scope.append(contextElement("p","기록 시작 이후 이 대화의 API 응답만 집계합니다. 전체 계정 사용량이나 청구액은 아닙니다. 공급자 한도는 마지막 응답 시점의 값입니다.","context-note"));
  if(usage.quotaNote)scope.append(contextElement("p",usage.quotaNote,"context-note"));
  else if(!providers.length)scope.append(contextElement("p","제공된 공급자 잔여 한도 정보가 없습니다.","context-note"));
  scope.addEventListener("toggle",()=>contextPopover?.position());section.append(scope);
}
async function openContextPopover(trigger,pane) {
  if(contextPopover?.trigger===trigger){closeContextPopover();return;}
  closeContextPopover();
  const {roomId,data}=roomContextOwner(pane),userId=state.session?.user?.id;if(!roomId)return;
  const native=typeof HTMLElement.prototype.showPopover==="function";
  const element=contextElement(native?"div":"dialog",undefined,"context-popover");element.setAttribute("role","dialog");element.setAttribute("aria-label","컨텍스트 및 API 사용량");if(native)element.setAttribute("popover","auto");
  const header=contextElement("header"),title=contextElement("h2","컨텍스트 및 API 사용량"),close=contextElement("button","×","context-popover-close");close.type="button";close.setAttribute("aria-label","사용량 닫기");close.onclick=closeContextPopover;header.append(title,close);
  const contextSection=contextElement("section"),usageSection=contextElement("section",undefined,"context-api-section");renderPopoverContext(contextSection,data?.context);usageSection.append(contextElement("p","API 기록을 확인하는 중…","context-muted"));
  const compact=contextElement("button","Compact · 대화 맥락 압축","context-compact-button"); compact.type="button";
  const owner=roomContextOwner(pane);compact.disabled=owner.busy||!owner.canManage||!(data?.context?.usedChars>=500);
  compact.title=owner.canManage ? "기록을 보존하고 다음 요청에 담을 맥락을 줄입니다" : "대화 소유자만 압축할 수 있습니다";
  compact.onclick=()=>sessionAction("compact",pane,compact);
  element.append(header,contextSection,compact,usageSection);document.body.append(element);
  const open={element,trigger,roomId,pane,userId,native,contextSection,compact,cancelled:false,abort:new AbortController()};
  open.position=()=>{
    if(!trigger.isConnected){closeContextPopover();return;}
    const rect=trigger.getBoundingClientRect(),width=element.offsetWidth,height=element.offsetHeight;
    element.style.left=Math.max(12,Math.min(innerWidth-width-12,rect.right-width))+"px";
    element.style.top=Math.max(12,Math.min(innerHeight-height-12,rect.top-height-10))+"px";
  };
  contextPopover=open;trigger.setAttribute("aria-expanded","true");
  if(native){element.addEventListener("toggle",event=>{if(event.newState==="closed"&&contextPopover===open)closeContextPopover();});element.showPopover();}
  else {element.addEventListener("close",()=>{if(contextPopover===open)closeContextPopover();});element.showModal();element.addEventListener("click",event=>{if(event.target===element){const r=element.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeContextPopover();}});}
  open.position();window.addEventListener("resize",open.position);window.addEventListener("scroll",open.position,true);
  try {
    const usage=await api(`/api/rooms/${encodeURIComponent(roomId)}/usage`,{signal:open.abort.signal});
    if(open.cancelled||contextPopover!==open||!contextOwnerCurrent(roomId,userId,pane))return;
    renderUsageSection(usageSection,usage);open.position();
  }catch(error){if(!open.cancelled){usageSection.replaceChildren(contextElement("p","API 기록을 불러오지 못했습니다. 다시 열어 확인해주세요.","context-note"));open.position();}}
}
async function createRoom(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  showMessage($("#room-form-message"), "");
  setBusy(button, true, "만드는 중…");
  try {
    const data = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: $("#room-name").value.trim(),
        description: $("#room-description-input").value.trim(),
      }),
    });
    closeDialog($("#room-dialog"));
    await loadRooms();
    await selectRoom(data.room.id);
    toast("대화를 만들었습니다.");
  } catch (error) {
    showMessage($("#room-form-message"), error.message);
  } finally {
    setBusy(button, false, "만들기");
  }
}
async function joinRoom(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  showMessage($("#join-form-message"), "");
  setBusy(button, true, "참여 중…");
  try {
    const data = await api("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify({ token: $("#join-token").value.trim() }),
    });
    inviteLinks.clear("room");
    closeDialog($("#join-dialog"));
    await loadRooms();
    await selectRoom(data.room.id);
    toast("대화에 참여했습니다.");
  } catch (error) {
    showMessage($("#join-form-message"), error.message);
  } finally {
    setBusy(button, false, "참여하기");
  }
}
async function makeInvite(path, title) {
  try {
    const data = await api(path, { method: "POST", body: "{}" });
    $("#invite-token").textContent = createInviteLink(title, data.token);
    $("#invite-expires").textContent = data.expiresAt
      ? `만료: ${formatDate(data.expiresAt)}`
      : "";
    $(".invite-modal h2").textContent =
      title === "site" ? "가입 초대 링크" : "대화 초대 링크";
    $(".invite-modal .eyebrow").textContent =
      title === "site" ? "SITE INVITATION" : "ROOM INVITATION";
    $("#invite-dialog").dataset.title = title;
    openDialog($("#invite-dialog"));
  } catch (error) {
    toast(error.message);
  }
}
function closeSidebar() {
  $("#sidebar").classList.remove("is-open");
  $("#sidebar-scrim").classList.remove("is-visible");
}
function roomPreferences(id) {
  try { return JSON.parse(localStorage.getItem("community-model:" + state.session.user.id + ":" + id) || "{}"); } catch { return {}; }
}
function saveRoomPreferences(id, prefs) {
  if (!id) return;
  try { localStorage.setItem("community-model:" + state.session.user.id + ":" + id, JSON.stringify(prefs)); } catch {}
}
function composerBlocked(pane = null) {
  const {roomId} = roomContextOwner(pane);
  return !roomId || roomId === MONITOR_ROOM || (pane ? pane.sending : state.sending) || modelChanges.has(roomId) || branchOperations.has(roomId);
}
function updateModelAvailability() {
  updateBranchControls();
  updateAgentPresence();
  for(const select of $$(".model-select")) {
    const pane=select._pane||null,owner=roomContextOwner(pane);
    const disabled=!owner.roomId||owner.busy;
    select.disabled=disabled;
    if(select._triggerButton)select._triggerButton.disabled=disabled;
    const form=select.closest("form");
    if(form) {
      const send=$('button[type="submit"]',form);
      const blocked=composerBlocked(pane), queued=!!owner.data?.busy;
      if(send){send.disabled=blocked;send.setAttribute("aria-label",queued?"대기열에 추가":"메시지 보내기");send.title=queued?"대기열에 추가 · 현재 답변이 끝나면 순서대로 보냅니다":"메시지 보내기";}
      const input=$("textarea",form);
      if(input){input.disabled=!!blocked;if(!input.dataset.idlePlaceholder)input.dataset.idlePlaceholder=input.placeholder;input.placeholder=queued?"다음 요청을 입력하세요. Enter를 누르면 대기열에 추가됩니다.":input.dataset.idlePlaceholder;}
      const actions=$$(".context-action",form);
      if(actions[0])actions[0].disabled=owner.busy;
      if(actions[1])actions[1].disabled=owner.busy||!owner.canManage||!(owner.data?.context?.usedChars>=500);
    }
  }
}
function confirmModelChange(label,canReset) {
  return new Promise(resolve=>{
    const dialog=contextElement("dialog",undefined,"model-change-dialog");dialog.setAttribute("aria-labelledby","model-change-title");
    const title=contextElement("h2","모델을 변경할까요?");title.id="model-change-title";
    const next=contextElement("p",label,"model-change-name");
    const note=contextElement("p","기록은 그대로 남습니다. 맥락을 초기화하면 이전 대화와 압축 요약을 다음 요청에 보내지 않습니다.","context-note");
    const actions=contextElement("div",undefined,"model-change-actions");
    let choice=null;
    for(const [value,text] of [["keep","맥락 유지하고 변경"],["reset","맥락 초기화 후 변경"],[null,"취소"]]) {
      const button=contextElement("button",text);button.type="button";button.disabled=value==="reset"&&!canReset;
      button.onclick=()=>{choice=value;dialog.close();};actions.append(button);
    }
    dialog.append(title,next,note);
    if(!canReset)dialog.append(contextElement("p","맥락 초기화는 세션 소유자만 할 수 있습니다.","context-note"));
    dialog.append(actions);dialog.addEventListener("close",()=>{dialog.remove();resolve(choice);},{once:true});
    document.body.append(dialog);dialog.showModal();
  });
}
async function requestModelChange(select, value) {
  const pane=select._pane||null,{roomId,busy}=roomContextOwner(pane),userId=state.session?.user?.id;
  const previous=select.dataset.chosen ?? select.value;
  select.value=previous;
  if(!roomId||!select.isConnected||busy||value===previous)return;
  const operation=Symbol("model-change");modelChanges.set(roomId,operation);select._changingModel=operation;updateModelAvailability();
  const stillCurrent=()=>select.isConnected&&contextOwnerCurrent(roomId,userId,pane);
  try {
    const model=state.models.find(item=>item.value===value);
    const choice=await confirmModelChange(value?(model?modelLabel(model):value):"자동 선택 · 추천",roomContextOwner(pane).canManage);
    if(!choice||!stillCurrent())return;
    if(roomContextOwner(pane).working){toast("답변이 끝난 뒤 모델을 변경해주세요.");return;}
    if(choice==="reset") {
      if(!roomContextOwner(pane).canManage)return;
      await api(`/api/rooms/${encodeURIComponent(roomId)}/context-reset`,{method:"POST",body:"{}"});
      if(!stillCurrent())return;
    }
    // Commit only after confirmation and, when requested, a successful server reset.
    select.dataset.chosen=value;
    if(pane)pane.model=value;
    const effort=pane?pane.effort||"":$("#effort-select").value;
    saveRoomPreferences(roomId,{model:value,effort});
    applyModels(state.models);
    if(choice==="reset")await refreshContextOwner(pane);
  } catch(error) {if(stillCurrent())toast(error.message);}
  finally {
    if(modelChanges.get(roomId)===operation)modelChanges.delete(roomId);
    if(select._changingModel===operation)select._changingModel=false;
    if(stillCurrent())select.value=select.dataset.chosen ?? previous;
    updateModelAvailability();
  }
}
function applyModels(models) {
  if (Array.isArray(models)) state.models = models;
  const recommended = recommendedModels(state.models);
  for (const select of $$(".model-select")) {
    const chosen = select.dataset.chosen ?? select.value;
    select.replaceChildren(new Option("자동 선택 · 추천", ""));
    const visible=[...recommended];
    const current=state.models.find(model=>model.value===chosen);
    if(current&&!visible.includes(current))visible.push(current);
    for(const model of visible)select.append(new Option(modelLabel(model)+(model===current&&!recommended.includes(model)?" · 선택됨":""),model.value));
    select.value=visible.some(model=>model.value===chosen)?chosen:"";
    select.dataset.chosen=select.value;
    if(!select._triggerButton){
      const trigger=document.createElement("button");trigger.type="button";trigger.className="model-trigger";trigger.setAttribute("aria-label","모델 선택");trigger.setAttribute("aria-haspopup","dialog");
      trigger.onclick=()=>openRecommendedModels(select,trigger);select.after(trigger);select._triggerButton=trigger;select.classList.add("custom-model-select");
    }
    select._triggerButton.textContent=(select.selectedOptions[0]?.textContent||"자동 선택 · 추천")+" ▾";
    select.title="추천 모델 · 자동 선택은 연결 상태에 따라 순환합니다";
  }
  updateModelAvailability();
}
function openRecommendedModels(select,trigger){
  if(select.disabled)return;
  const dialog=document.createElement("dialog");dialog.className="quick-model-picker";dialog.setAttribute("aria-label","추천 모델 선택");
  const title=document.createElement("h2");title.textContent="추천 모델";dialog.append(title);
  const entries=[{value:"",id:"",name:"자동 선택 · 추천"},...recommendedModels(state.models)];
  const current=state.models.find(m=>m.value===select.value);if(current&&!entries.some(m=>m.value===current.value))entries.push(current);
  for(const model of entries){const button=document.createElement("button");button.type="button";button.className="quick-model-option";button.textContent=(model.value?modelLabel(model):model.name)+(select.value===model.value?" ✓":"");button.setAttribute("aria-pressed",String(select.value===model.value));button.onclick=()=>{dialog.close();void requestModelChange(select,model.value);};dialog.append(button);}
  const more=document.createElement("button");more.type="button";more.className="quick-model-more";more.textContent="전체 모델 검색 →";more.onclick=()=>{dialog.close();openModelBrowser(select,trigger);};dialog.append(more);
  const close=document.createElement("button");close.type="button";close.className="quick-model-more";close.textContent="닫기";close.onclick=()=>dialog.close();dialog.append(close);
  dialog.onclose=()=>{dialog.remove();if(trigger.isConnected&&!$("dialog[open]"))trigger.focus();};
  dialog.addEventListener("click",event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  document.body.append(dialog);dialog.showModal();
}
let modelBrowser;
function openModelBrowser(select,trigger) {
  if(select.disabled)return;
  if(!modelBrowser){
    modelBrowser=document.createElement("dialog");modelBrowser.className="model-browser";modelBrowser.setAttribute("aria-labelledby","model-browser-title");
    modelBrowser.innerHTML='<header><div><span class="picker-eyebrow">MODEL LIBRARY</span><h2 id="model-browser-title">어떤 모델과 대화할까요?</h2></div><button type="button" class="model-browser-close" aria-label="모델 선택 닫기">×</button></header><input class="model-search" type="search" placeholder="모델 또는 공급자 검색" aria-label="모델 또는 공급자 검색"><p class="model-count" role="status"></p><div class="model-results"></div><button class="model-load-more" type="button">더 불러오기</button>';
    document.body.append(modelBrowser);
    $(".model-browser-close",modelBrowser).onclick=()=>modelBrowser.close();
    modelBrowser.addEventListener("click",event=>{if(event.target===modelBrowser){const r=modelBrowser.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modelBrowser.close();}});
  }
  const search=$(".model-search",modelBrowser), results=$(".model-results",modelBrowser), load=$(".model-load-more",modelBrowser);
  let count=60;
  const recommended=new Set(recommendedModels(state.models).map(m=>m.value));
  function render(){
    const matching=filterModels(state.models,search.value);
    results.replaceChildren();
    $(".model-count",modelBrowser).textContent=matching.length?`${matching.length}개 모델 · ${Math.min(count,matching.length)}개 표시`:"일치하는 모델이 없어요. 다른 이름이나 공급자로 검색해 보세요.";
    for(const model of matching.slice(0,count)){
      const button=document.createElement("button");button.type="button";button.className="model-card";button.setAttribute("aria-pressed",String(select.value===model.value));
      const name=document.createElement("strong"),detail=document.createElement("span"),badge=document.createElement("small");
      name.textContent=modelLabel(model);detail.textContent=(model.providers||[]).join(" · ");badge.textContent=select.value===model.value?"선택됨":recommended.has(model.value)?"추천":model.id;
      button.append(name,detail,badge);button.title=model.id;
      button.onclick=()=>{modelBrowser.close();void requestModelChange(select,model.value);};results.append(button);
    }
    load.hidden=count>=matching.length;
  }
  search.value="";search.oninput=()=>{count=60;render();};load.onclick=()=>{count+=60;render();};modelBrowser.onclose=()=>{if(trigger.isConnected&&!$("dialog[open]"))trigger.focus();};
  render();modelBrowser.showModal();search.focus();
}
function setLayout(count) {
  if (!state.selectedRoom || count < 2 || count > 8) return;
  state.extra.forEach(pane => clearAttachmentDraft(pane));
  if (state.layout === count) {
    state.layout = 1;
    state.extra = [];
    state.focusPane = 0;
    $("#pane-grid").dataset.panes = "1";
    $("#pane-grid").classList.remove("docked");
    $("#room-view").style.gridColumn = "";
    $("#room-view").classList.remove("is-focus");
    $$(".extra-pane").forEach((pane) => pane.remove());
    $$(".split-picker button").forEach((button) => {
      button.classList.remove("is-on");
      button.setAttribute("aria-pressed", "false");
    });
    renderRooms();
    syncProgressStreams();
    return;
  }
  state.layout = count;
  state.focusPane = 0;
  const ids = [state.selectedRoom];
  for (const room of state.rooms) {
    if (ids.length >= count) break;
    if (!ids.includes(room.id)) ids.push(room.id);
  }
  state.extra = ids.slice(1).map((roomId) => ({ roomId, data: null, busy: false, request: 0, model: "", effort: "" }));
  while (state.extra.length < count - 1) state.extra.push({ roomId: null, data: null, busy: false, request: 0, model: "", effort: "" });
  $("#pane-grid").dataset.panes = String(count);
  $$(".split-picker button").forEach((button) => {
    const on = Number(button.dataset.split) === count;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  $("#room-view").classList.add("is-focus");
  renderExtraPanes();
  renderRooms();
  refreshExtras();
}
function renderExtraPanes() {
  if(contextPopover?.pane)closeContextPopover();
  syncProgressStreams();
  const grid = $("#pane-grid");
  const spans = { 5: [2, 2, 2, 3, 3], 7: [3, 3, 3, 3, 4, 4, 4] }[state.layout];
  $$(".extra-pane", grid).forEach((pane) => {pane._desktop?.destroy();pane.remove();});
  $("#room-view").style.gridColumn = spans ? "span " + spans[0] : "";
  state.extra.forEach((pane, index) => {
    Object.assign(pane, roomPreferences(pane.roomId));
    const room = state.rooms.find((item) => item.id === pane.roomId);
    const section = document.createElement("section");
    section.className = "room-view extra-pane" + (state.focusPane === index + 1 ? " is-focus" : "");
    if (spans) section.style.gridColumn = "span " + spans[index + 1];
    const focusBranchPane = () => {
      if(state.focusPane===index+1)return;
      state.focusPane = index + 1;
      $("#room-view").classList.remove("is-focus");
      $$(".extra-pane").forEach((item, itemIndex) => item.classList.toggle("is-focus", itemIndex + 1 === state.focusPane));
      renderRooms();
    };
    section.addEventListener("mousedown",focusBranchPane);section.addEventListener("focusin",focusBranchPane);
    const header = document.createElement("header");
    header.className = "pane-bar";
    const title = document.createElement("h2");
    title.textContent = room?.name || "대화 선택";
    header.append(title);
    const desktopButton = document.createElement("button");
    desktopButton.type = "button";
    desktopButton.textContent = "작업 공간";
    desktopButton.disabled = !pane.roomId;
    desktopButton.addEventListener("click", () => desktopUI?.openRoom(pane.roomId));
    header.append(desktopButton);
    const callButton = document.createElement("button");
    callButton.type = "button"; callButton.className = "voice-call-button"; callButton.append(icon("phone"));
    callButton.setAttribute("aria-label", "이 대화에 전화하기"); callButton.title = "이 대화에 전화하기";
    callButton.disabled = !room || room.archived || room.id === MONITOR_ROOM;
    callButton.onclick = () => voiceUI?.open(room); header.append(callButton);

    const list = document.createElement("div");
    list.className = "message-list";
    const messages = mergePendingMessages(pane.data?.messages || [],pendingMessages.get(pane.roomId));
    if (messages.length) messages.forEach((message) => list.append(createMessage(message,pane,pane.roomId)));
    else {
      const empty = document.createElement("div");
      empty.className = "message-empty";
      const note = document.createElement("span");
      note.textContent = pane.roomId ? "메시지를 불러오는 중…" : "이 칸을 누른 뒤 왼쪽 대화를 고르세요.";
      empty.append(note);
      list.append(empty);
    }
    section.classList.toggle("agent-working", !!pane.data?.busy);
    if (pane.data?.busy && pane.data.room?.id === pane.roomId) list.append(thinkingRow(pane.roomId));
    const form = document.createElement("form");
    form.className = "composer pane-composer";
    form.addEventListener("submit", (event) => submitPane(event, index));
    const controls = document.createElement("div");
    controls.className = "model-controls";
    controls.append(modelSelect(pane), effortSelect(pane));
    const row = document.createElement("div");
    row.className = "composer-row";
    const input = document.createElement("textarea");
    input.rows = 1;
    input.value=pane.draft || "";
    input.addEventListener("input",()=>{pane.draft=input.value;});
    input.addEventListener("paste", event => pasteAttachments(event, pane));
    input.maxLength = 4000;
    input.placeholder = "메시지 보내기. model 이면 목록을 가져옵니다.";
    input.setAttribute("aria-label", (room?.name || "대화") + " 메시지");
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "send-button";
    send.setAttribute("aria-label", "메시지 보내기");
    send.append(icon("arrow"));
    const attach = document.createElement("button");
    attach.type = "button"; attach.className = "bot-picker-button attach-button";
    attach.setAttribute("aria-label", "사진 또는 음성 첨부"); attach.title = "사진 또는 음성 첨부 · 이미지 붙여넣기도 가능해요";
    attach.append(icon("attach"));
    const fileInput = document.createElement("input");
    fileInput.type = "file"; fileInput.className = "sr-only"; fileInput.accept = "image/png,image/jpeg,image/webp,image/gif,audio/*"; fileInput.multiple = true;
    attach.onclick = () => { if (!composerBlocked(pane)) fileInput.click(); };
    fileInput.onchange = () => { void uploadAttachments(fileInput.files, pane); fileInput.value = ""; };
    row.append(attach, fileInput, input, send);
    const attachmentList = document.createElement("div");
    attachmentList.className = "attachment-list"; attachmentList.setAttribute("aria-live", "polite");
    form.append(controls, row, attachmentList);
    renderContextMeter(pane.data?.context,form,pane);
    messageQueueUI?.render(form, pane.roomId, pane.data?.queue);
    section.append(header, list, form);
    grid.append(section);
    renderPendingAttachments(pane);

  });
  applyModels(state.models);
  applyDockLayout();
}
function modelSelect(pane) {
  const label = document.createElement("label");
  label.append(document.createTextNode("모델 "));
  const select = document.createElement("select");
  select.className = "model-select";
  select.setAttribute("aria-label", "모델");
  select.dataset.chosen = pane.model || "";
  select._pane=pane;
  select.addEventListener("change", () => { void requestModelChange(select,select.value); });
  label.append(select);
  return label;
}
function effortSelect(pane) {
  const label = document.createElement("label");
  label.append(document.createTextNode("effort "));
  const select = document.createElement("select");
  select.className = "effort-select";
  select.setAttribute("aria-label", "effort");
  for (const [value, text] of [["", "기본"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = pane.effort || "";
  select.addEventListener("change", () => { pane.effort = select.value; saveRoomPreferences(pane.roomId, {model:pane.model || "", effort:pane.effort}); });
  label.append(select);
  return label;
}
async function submitPane(event, index, skipTopic = false) {
  event.preventDefault();
  const pane = state.extra[index];
  if (!pane || composerBlocked(pane)) return;
  const form = event.currentTarget;
  const input = $("textarea", form);
  const text = input.value.trim();
  const attachments = (pane.pendingAttachments || []).filter(item => item.attachment && !item.error);
  if ((pane.pendingAttachments || []).some(item => item.uploading)) { toast("첨부 파일 업로드가 끝날 때까지 기다려주세요."); return; }
  if ((pane.pendingAttachments || []).some(item => item.error)) { toast("업로드하지 못한 첨부 파일을 제거한 뒤 다시 첨부해 주세요."); return; }
  if (!text && !attachments.length) return;
  const attachmentGeneration = pane.attachmentGeneration;
  const roomId=pane.roomId,userId=state.session?.user?.id;
  if(topicPrompts.has(roomId))return;
  if(!skipTopic && !attachments.length && await offerTopicChoice(pane,text))return;
  if(!contextOwnerCurrent(roomId,userId,pane)||composerBlocked(pane))return;
  const attachmentIds = attachments.map(item => item.attachment.id);
  const signature=JSON.stringify({roomId,text,attachmentIds,model:pane.model,effort:pane.effort});
  if(pane.pendingSend?.signature!==signature)pane.pendingSend={signature,nonce:crypto.randomUUID()};
  const nonce=pane.pendingSend.nonce;
  const payload=JSON.stringify({text,botIds:[...state.selectedBots],attachmentIds,clientNonce:nonce,model:$(".model-select",form).value,effort:$(".effort-select",form).value,queueIfBusy:true});
  presenceErrors.delete(roomId);
  pane.sending = true;
  updateModelAvailability();
  input.value=""; pane.draft="";input.disabled=true;
  const pending=pane.data?.busy ? null : await optimisticMessage(roomId,text,nonce,attachments.map(item => item.attachment));
  let accepted=false;
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: payload,
      retryable: true,
    });
    accepted=true;
    if(state.session?.user?.id!==userId)return;
    if(result.queued && pendingMessages.get(roomId)===pending)pendingMessages.delete(roomId);
    if(result.messageId&&pending)pending.id=result.messageId;
    if(result.queued)paintPending(roomId);
    pane.pendingSend=null;
    if (Array.isArray(result.models)) applyModels(result.models);
    if(contextOwnerCurrent(roomId,userId,pane) && pane.attachmentGeneration===attachmentGeneration)clearPendingAttachments(pane);
    if(contextOwnerCurrent(roomId,userId,pane))await refreshExtra(state.extra.indexOf(pane));
    await loadRooms();
  } catch (error) {
    if(state.session?.user?.id!==userId)return;
    if(accepted){toast("메시지는 접수됐습니다. 대화를 다시 불러오고 있어요.");return;}
    presenceErrors.add(roomId);if(pending)pending.pending="failed";
    if(pane.roomId===roomId){input.value=text;pane.draft=text;}
    paintPending(roomId);toast(error.message);
  } finally {
    if(state.session?.user?.id!==userId)return;
    input.disabled=false;
    pane.sending = false;
    updateModelAvailability();
  }
}
async function refreshExtra(index) {
  const pane = state.extra[index];
  if (!pane?.roomId || pane.busy) return;
  const request = ++pane.request;
  const roomId = pane.roomId, userId = state.session?.user?.id;
  pane.busy = true;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    if (state.session?.user?.id !== userId || state.extra[index] !== pane || pane.roomId !== roomId || pane.request !== request) return;
    const unchanged = JSON.stringify(pane.data) === JSON.stringify(data);
    pane.data = data;
    notificationUI?.observeRoom(data, { userId });
    observeRoomOutcome(data);
    syncProgressStreams();
    if (unchanged) return;
    const section = $$(".extra-pane")[index];
    if (!section) return;
    renderContextMeter(data.context,$(".pane-composer",section),pane);
    messageQueueUI?.render($(".pane-composer",section), roomId, data.queue);
    const list = $(".message-list", section);
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    list.replaceChildren();
    const messages = mergePendingMessages(data.messages || [],pendingMessages.get(roomId));
    if (messages.length) messages.forEach((message) => list.append(createMessage(message,pane,roomId)));
    else {
      const empty = document.createElement("div");
      empty.className = "message-empty";
      const note = document.createElement("span");
      note.textContent = "메시지를 보내 대화를 시작하세요.";
      empty.append(note);
      list.append(empty);
    }
    section.classList.toggle("agent-working", !!data.busy);
    if (data.busy) list.append(thinkingRow(roomId));
    if (nearBottom) list.scrollTop = list.scrollHeight;
    $("h2", section).textContent = data.room?.name || "대화";
    const listed=state.rooms.find(room=>room.id===roomId);
    if(listed&&data.room?.name&&listed.name!==data.room.name){listed.name=data.room.name;renderRooms();}
  } catch (error) {
    if (pane.request !== request) return;
    if (error.status === 401) { state.session = null; showAuth(); }
    else {
      if (error.status === 403 || error.status === 404) { pane.data = null; syncProgressStreams(); }
      toast(error.message);
    }
  } finally {
    if (pane.request === request) pane.busy = false;
  }
}
function refreshExtras() {
  state.extra.forEach((_, index) => { void refreshExtra(index); });
}
function assignExtra(index, roomId) {
  const pane = state.extra[index];
  if (!pane || roomId === state.selectedRoom || pane.roomId === roomId) return;
  state.extra.forEach((item, itemIndex) => {
    if (itemIndex !== index && item.roomId === roomId) { clearAttachmentDraft(item); item.roomId = pane.roomId; }
  });
  clearAttachmentDraft(pane);
  pane.roomId = roomId;
  pane.data = null;
  pane.busy = false;
  renderExtraPanes();
  renderRooms();
  void refreshExtra(index);
}
function bind() {
  setupSidebarResize();
  $("#create-sidebar-group").addEventListener("click",()=>openSidebarGroupEditor());
  $("#branch-fork").addEventListener("click",()=>void sessionAction("fork",null,$("#branch-fork"),null,null,currentBranchId()));
  $("#branch-merge").addEventListener("click",()=>mergeBranch(currentBranchId()));
  $("#room-search").addEventListener("input", renderRooms);
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      state.session?.user &&
      !event.target.matches("input, textarea") &&
      !document.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      $("#sidebar").classList.add("is-open");
      $("#sidebar-scrim").classList.add("is-visible");
      $("#room-search").focus();
    }
    if (event.key === "Escape") {
      $("#bot-picker").classList.add("is-hidden");
      $("#bot-picker-button").setAttribute("aria-expanded", "false");
      els.memberPanel.classList.remove("is-open");
      closeSidebar();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#bot-picker, #bot-picker-button")) {
      $("#bot-picker").classList.add("is-hidden");
      $("#bot-picker-button").setAttribute("aria-expanded", "false");
    }
  });
  $$("[data-auth-tab]").forEach((button) =>
    button.addEventListener("click", () => switchAuth(button.dataset.authTab)),
  );
  els.login.addEventListener("submit", (event) =>
    authSubmit(event, "/api/login", "로그인"),
  );
  els.register.addEventListener("submit", (event) =>
    authSubmit(event, "/api/register", "계정 만들기"),
  );
  $("#logout-button").addEventListener("click", async () => {
    try {
      voiceUI?.reset();
      await pwaUI?.clearSession({ keepSession: true });
      await api("/api/logout", { method: "POST", body: "{}" });
      await pwaUI?.clearSession();
      state.session = null;
      showAuth();
    } catch (error) {
      toast(error.message);
    }
  });
  ["#create-room-button", "#empty-create-button"].forEach((selector) =>
    $(selector).addEventListener("click", startNewSession),
  );
  $("#room-form").addEventListener("submit", createRoom);
  $("#join-form").addEventListener("submit", joinRoom);
  $("#composer-form").addEventListener("submit", submitMessage);
  $("#model-select").addEventListener("change",()=>{void requestModelChange($("#model-select"),$("#model-select").value);});
  $("#effort-select").addEventListener("change",()=>{
    saveRoomPreferences(state.selectedRoom,{model:$("#model-select").dataset.chosen || "",effort:$("#effort-select").value});
  });
  $("#room-view").addEventListener("focusin", () => {
    if(state.focusPane===0)return;state.focusPane=0;desktopUI?.setRoom(state.selectedRoom);
    $("#room-view").classList.add("is-focus");$$(".extra-pane").forEach(pane=>pane.classList.remove("is-focus"));renderRooms();
  });
  $("#room-view").addEventListener("mousedown", () => {
    if (state.layout < 2) return;
    state.focusPane = 0;
    desktopUI?.setRoom(state.selectedRoom);
    $("#room-view").classList.add("is-focus");
    $$(".extra-pane").forEach((pane) => pane.classList.remove("is-focus"));
    renderRooms();
  });
  $$(".split-picker button").forEach((button) => {
    button.addEventListener("click", () => setLayout(Number(button.dataset.split)));
  });
  $("#attach-button").addEventListener("click", () => $("#attachment-input").click());
  $("#attachment-input").addEventListener("change", (event) => {
    uploadAttachments(event.target.files);
    event.target.value = "";
  });
  $("#record-button").addEventListener("click", toggleRecording);
  $("#voice-call-button").addEventListener("click", () => voiceUI?.open(state.rooms.find(room => room.id === currentBranchId())));
  $("#record-cancel-button").addEventListener("click", () => {
    if (!state.recording) return;
    state.recordingCancelled = true;
    state.recording.stop();
    toast("녹음을 취소했습니다.");
  });
  $("#message-input").addEventListener("paste", event => pasteAttachments(event));
  $("#message-input").addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#composer-form").requestSubmit();
    }
  });
  $("#message-input").addEventListener("input", (event) => {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`;
  });
  $("#bot-picker-button").addEventListener("click", () => {
    const picker = $("#bot-picker");
    const hidden = picker.classList.toggle("is-hidden");
    $("#bot-picker-button").setAttribute("aria-expanded", String(!hidden));
  });
  $("#members-toggle").addEventListener("click", () =>
    els.memberPanel.classList.toggle("is-open"),
  );
  $("#member-close").addEventListener("click", () =>
    els.memberPanel.classList.remove("is-open"),
  );
  $("#room-invite-button").addEventListener("click", () => sharingUI?.open(state.roomData?.room || state.rooms.find(room=>room.id===state.selectedRoom)));
  $("#profile-customize").addEventListener("click", () => profileUI?.open());
  $("#site-invite-button").addEventListener("click", () =>
    makeInvite("/api/admin/invites", "site"),
  );
  $("#copy-invite").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#invite-token").textContent);
      toast("초대 링크를 복사했습니다.");
    } catch {
      toast("복사하지 못했습니다. 링크를 직접 선택해주세요.");
    }
  });
  $("#mobile-menu").addEventListener("click", () => {
    if (matchMedia("(max-width: 720px)").matches) {
      const open = $("#sidebar").classList.toggle("is-open");
      $("#sidebar-scrim").classList.toggle("is-visible", open);
      $("#mobile-menu").setAttribute("aria-expanded", String(open));
    } else {
      const hidden = els.workspace.classList.toggle("sidebar-collapsed");
      $("#mobile-menu").setAttribute("aria-expanded", String(!hidden));
    }
  });
  setupDock();
  $("#mobile-close").addEventListener("click", closeSidebar);
  $("#sidebar-scrim").addEventListener("click", closeSidebar);
  $$(".modal-close, .modal-cancel").forEach((button) =>
    button.addEventListener("click", () =>
      closeDialog(button.closest("dialog")),
    ),
  );
  $("#image-dialog-close").addEventListener("click", () => closeDialog($("#image-dialog")));
  $$("dialog").forEach((dialog) =>
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog(dialog);
    }),
  );
}
function openPendingRoomInvite() {
  const token = inviteLinks.get("room");
  if (!state.session?.user || !token) return false;
  $("#join-token").value = token; $("#join-token").hidden = true; $("#join-token-label").hidden = true;
  $("#join-invite-note").classList.remove("is-hidden"); openDialog($("#join-dialog")); return true;
}
window.addEventListener("hashchange", () => {
  if (!inviteLinks.capture()) return;
  if (state.session?.user) openPendingRoomInvite(); else showAuth();
});
bind();
agentPresence = createAgentPresence({ mount: $("#agent-presence") });
notificationUI = createNotificationCenter({ mount: $("#notification-center"), openRoom: async id => { await loadRooms(); await selectRoom(id); }, toast });
pwaUI = createPwaController({ api, getSession: () => state.session, toast });
desktopUI = createDesktopUI({ api, getRoomId: () => state.selectedRoom, getRoomName: id => state.rooms.find(room=>room.id===id)?.name || "대화", toast });
profileUI = createProfileSettings({api,getSession:()=>state.session,toast,onSaved: user=>{state.session.user=user;$("#profile-name").textContent=user.displayName;$("#profile-avatar").textContent=initials(user.displayName);$("#profile-avatar").style.backgroundColor=user.avatarColor || "";}});
routineUI = createRoutineUI({api,getSession:()=>state.session,getRoom:()=>state.rooms.find(room=>room.id===currentBranchId()),toast,onChanged:async()=>{await refreshRoom(true);await loadRooms();refreshExtras();}});
messageQueueUI = createMessageQueue({api, getSession:()=>state.session, toast, onRefresh:async roomId=>{
  const tasks=[];
  if(state.selectedRoom===roomId)tasks.push(refreshRoom(true));
  state.extra.forEach((pane,index)=>{if(pane.roomId===roomId)tasks.push(refreshExtra(index));});
  await Promise.all(tasks);
}});
voiceUI = createVoiceCall({api,getSession:()=>state.session,getRoom:id=>state.rooms.find(room=>room.id===id),toast,
  beforeStart:cancelActiveRecording,
  getSelection:id=>{
    const prefs=roomPreferences(id),pane=state.extra.find(item=>item.roomId===id);
    return {model:id===state.selectedRoom?$("#model-select").value:pane?.model||prefs.model||"",effort:id===state.selectedRoom?$("#effort-select").value:pane?.effort||prefs.effort||"",botIds:[state.selectedBots[0]||state.bots[0]?.id].filter(Boolean)};
  },
  onMessages:id=>{if(state.selectedRoom===id)void refreshRoom(true);refreshExtras();}
});
sharingUI = createRoomSharing({api,getSession:()=>state.session,toast,onRoomCreated:async room=>{await loadRooms();await selectRoom(room.id);},onInvite:room=>makeInvite(`/api/rooms/${encodeURIComponent(room.id)}/invites`,"room")});
const workspaceButton = $(".topbar-actions .desktop-button");
if (workspaceButton) {
  const monitor = document.createElementNS("http://www.w3.org/2000/svg", "svg"); monitor.setAttribute("class", "icon"); monitor.setAttribute("viewBox", "0 0 24 24"); monitor.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M4 4h16v12H4zM12 16v4m-4 0h8"); monitor.append(path); workspaceButton.replaceChildren(monitor);
  workspaceButton.setAttribute("aria-label", "작업 공간 열기 또는 닫기"); workspaceButton.title = "작업 공간";
}
setupUI = createBotSetupUI({ api, getSession: () => state.session, onSaved: refreshSetupState, toast });
mailUI = createMailUI({ api, getSession: () => state.session, toast, openRoom: async id => {await loadRooms();await selectRoom(id);} });
loadSession();


// Docking changes only the arrangement; room identity and permissions stay unchanged.
function dockPanels() { return [$("#room-view"), ...$$(".extra-pane")]; }
function applyDockLayout() {
  const grid = $("#pane-grid");
  grid.classList.toggle("docked", dockRects.length > 1);
  dockPanels().forEach((panel, index) => {
    panel.dataset.dockIndex = index;
    let close=panel.querySelector(":scope > .pane-close");
    if(dockRects.length>1) {
      if(!close){close=document.createElement("button");close.className="pane-close";close.type="button";close.textContent="×";panel.append(close);}
      close.setAttribute("aria-label",(dockRoomAt(index)?state.rooms.find(r=>r.id===dockRoomAt(index))?.name || "대화":"빈")+" 분할 닫기");
      close.onclick=()=>closeDockPane(index);
    } else close?.remove();
    const rect = dockRects[index];
    if (rect && dockRects.length > 1) Object.assign(panel.style, {left:rect.x*100+"%", top:rect.y*100+"%", width:rect.w*100+"%", height:rect.h*100+"%", gridColumn:""});
    else for (const key of ["left","top","width","height"]) panel.style[key] = "";
    const handle = index ? panel.querySelector(".pane-bar") : $(".header-identity");
    if (handle) { handle.draggable = false; handle.dataset.dockIndex = index; handle.title = "드래그해서 이동 · 우클릭으로 분할"; }
  });
}
async function closeDockPane(index) {
  if(dockRects.length<2)return;
  if(index===0 ? $("#message-input").value.trim() : state.extra[index-1]?.draft?.trim()) {toast("작성 중인 메시지를 보내거나 비운 뒤 창을 닫아주세요.");return;}
  if ((index === 0 ? state.pendingAttachments.length || state.extra[0]?.pendingAttachments?.length : state.extra[index-1]?.pendingAttachments?.length)) {
    toast("첨부 파일을 보내거나 제거한 뒤 창을 닫아주세요."); return;
  }
  let promote;
  if(index===0){promote=state.extra.shift();if(promote)clearAttachmentDraft(promote);} else {clearAttachmentDraft(state.extra[index-1]);state.extra.splice(index-1,1);}
  const count=state.extra.length+1;
  dockRects=Array.from({length:count},(_,i)=>({x:i/count,y:0,w:1/count,h:1}));
  state.layout=count;state.focusPane=0;$("#pane-grid").dataset.panes=String(count);
  if(promote?.roomId) await selectRoom(promote.roomId);
  renderExtraPanes();renderRooms();applyDockLayout();
}
function dockRoomAt(index) { return index === 0 ? state.selectedRoom : state.extra[index-1]?.roomId; }
function dockZone(panel, event) {
  const r=panel.getBoundingClientRect(), x=(event.clientX-r.left)/r.width, y=(event.clientY-r.top)/r.height;
  const distances=[x,1-x,y,1-y], side=["left","right","top","bottom"][distances.indexOf(Math.min(...distances))];
  return Math.min(...distances) > .3 && pendingDock?.index !== undefined ? "center" : side;
}
function placeDock(index, side) {
  if (!pendingDock || !state.selectedRoom) return;
  const source = pendingDock; pendingDock = null;
  if (source.index !== undefined) {
    if (source.index === index) return;
    // Move existing panes without restarting their sessions.
    [dockRects[source.index],dockRects[index]]=[dockRects[index],dockRects[source.index]];
    applyDockLayout(); return;
  }
  if (dockRects.length >= 8) { toast("분할 화면은 최대 8개입니다."); return; }
  const r = dockRects[index], next={...r};
  if (side === "left" || side === "right") {
    next.w=r.w/2; r.w/=2;
    if (side === "left") r.x+=r.w; else next.x+=r.w;
  } else {
    next.h=r.h/2; r.h/=2;
    if (side === "top") r.y+=r.h; else next.y+=r.h;
  }
  dockRects.push(next);
  state.extra.push({roomId:source.roomId, data:null,busy:false,request:0,...roomPreferences(source.roomId)});
  state.layout=dockRects.length;
  $("#pane-grid").dataset.panes=String(state.layout);
  renderExtraPanes(); renderRooms(); refreshExtras(); applyDockLayout();
}
function setupDock() {
  const grid=$("#pane-grid"), preview=document.createElement("div"), menu=document.createElement("div");
  preview.className="dock-preview"; preview.hidden=true; preview.textContent="여기에 놓기"; document.body.append(preview);
  menu.className="dock-menu"; menu.hidden=true; menu.setAttribute("role","menu"); document.body.append(menu);
  const hide=()=>{preview.hidden=true; menu.hidden=true;};
  function previewAt(panel,event) {
    const side=dockZone(panel,event), r=panel.getBoundingClientRect();
    let x=r.left,y=r.top,w=r.width,h=r.height;
    if (pendingDock?.index === undefined) {
      if(side==="left"||side==="right"){w/=2;if(side==="right")x+=w;}
      else {h/=2;if(side==="bottom")y+=h;}
    }
    Object.assign(preview.style,{left:x+"px",top:y+"px",width:w+"px",height:h+"px"});preview.hidden=false;
    return side;
  }
  let pointerDock = null, suppressClick = false;
  document.addEventListener("pointerdown", event => {
    if (event.button !== 0 || pendingDock?.placing || event.target.closest("select,input,textarea")) return;
    const room = event.target.closest("[data-dock-room]"), handle = event.target.closest(".pane-bar[data-dock-index],.header-identity[data-dock-index]");
    if (!room && (!handle || event.target.closest("button"))) return;
    pointerDock = {x:event.clientX,y:event.clientY,source:room ? {roomId:room.dataset.dockRoom} : {index:Number(handle.dataset.dockIndex)}};
  });
  document.addEventListener("pointermove", event => {
    if (!pointerDock) return;
    if (!pointerDock.active && Math.hypot(event.clientX-pointerDock.x,event.clientY-pointerDock.y)<7) return;
    pointerDock.active=true;pendingDock=pointerDock.source;
    event.preventDefault();
    const panel=document.elementFromPoint(event.clientX,event.clientY)?.closest("#pane-grid > .room-view");
    if(panel) previewAt(panel,event); else preview.hidden=true;
  });
  document.addEventListener("pointerup", event => {
    if (!pointerDock) return;
    if(pointerDock.active){
      const panel=document.elementFromPoint(event.clientX,event.clientY)?.closest("#pane-grid > .room-view");
      if(panel) placeDock(Number(panel.dataset.dockIndex),dockZone(panel,event));
      pendingDock=null;hide();suppressClick=true;setTimeout(()=>{suppressClick=false;},0);
    }
    pointerDock=null;
  });
  document.addEventListener("click", event=>{if(suppressClick){event.preventDefault();event.stopImmediatePropagation();}},true);
  document.addEventListener("pointercancel",()=>{pointerDock=null;pendingDock=null;hide();});
  document.addEventListener("dragstart",event=>{
    const room=event.target.closest("[data-dock-room]"), handle=event.target.closest("[draggable=true][data-dock-index]");
    if(room) pendingDock={roomId:room.dataset.dockRoom};
    else if(handle) pendingDock={index:Number(handle.dataset.dockIndex)};
    else return;
    event.dataTransfer.setData("text/plain","openclaw-pane"); event.dataTransfer.effectAllowed="move";
  });
  grid.addEventListener("dragover",event=>{const panel=event.target.closest("[data-dock-index]");if(!panel||!pendingDock)return;event.preventDefault();previewAt(panel,event);});
  grid.addEventListener("drop",event=>{const panel=event.target.closest("[data-dock-index]");if(!panel||!pendingDock)return;event.preventDefault();placeDock(Number(panel.dataset.dockIndex),dockZone(panel,event));hide();});
  document.addEventListener("dragend",()=>{pendingDock=null;hide();});
  grid.addEventListener("pointermove",event=>{const panel=event.target.closest("[data-dock-index]");if(pendingDock?.placing&&panel)previewAt(panel,event);});
  grid.addEventListener("click",event=>{const panel=event.target.closest("[data-dock-index]");if(pendingDock?.placing&&panel){event.preventDefault();event.stopImmediatePropagation();placeDock(Number(panel.dataset.dockIndex),dockZone(panel,event));hide();}},true);
  const begin=roomId=>{pendingDock={roomId,placing:true};menu.hidden=true;toast("놓을 위치를 가리킨 뒤 클릭하세요. Esc로 취소합니다.");};
  document.addEventListener("contextmenu",event=>{
    const room=event.target.closest("[data-dock-room]"), panel=event.target.closest("[data-dock-index]");
    if(!room&&!panel)return;if(event.target.closest("textarea,input"))return;
    event.preventDefault();menu.replaceChildren();
    const action=document.createElement("button");action.type="button";action.setAttribute("role","menuitem");action.textContent="Split view로 열기";
    action.onclick=()=>begin(room?.dataset.dockRoom || dockRoomAt(Number(panel.dataset.dockIndex)));menu.append(action);
    const targetRoom=state.rooms.find(r=>r.id===(room?.dataset.dockRoom || dockRoomAt(Number(panel.dataset.dockIndex))));
    if(targetRoom) {
      const addAction=(label,handler)=>{const b=document.createElement("button");b.type="button";b.setAttribute("role","menuitem");b.textContent=label;b.onclick=()=>{menu.hidden=true;handler();};menu.append(b);};
      if(targetRoom.id!==MONITOR_ROOM&&!targetRoom.archived){
        addAction("여기서 Fork",()=>void sessionAction("fork",null,null,null,null,targetRoom.id));
        addAction("다른 가지와 Merge",()=>mergeBranch(targetRoom.id));
      }
      if(sidebarState.loaded&&sidebarState.groups.length&&targetRoom.id!==MONITOR_ROOM)addAction("그룹으로 이동",()=>openRoomGroupPicker(targetRoom));
      addAction(targetRoom.pinned?"고정 해제":"상단에 고정",()=>updateRoomListPreference(targetRoom,{pinned:!targetRoom.pinned}));
      addAction(targetRoom.archived?"대화 복원":"대화 삭제",()=>{
        if(targetRoom.archived) return updateRoomListPreference(targetRoom,{archived:false});
        const dialog=document.createElement("dialog");dialog.className="quick-model-picker";
        const text=document.createElement("p");text.textContent="내 대화 목록에서 삭제할까요? 삭제한 대화에서 복원할 수 있으며 다른 참여자의 대화는 유지됩니다.";
        const confirm=document.createElement("button");confirm.textContent="삭제";confirm.onclick=()=>{dialog.close();updateRoomListPreference(targetRoom,{archived:true});};
        const cancel=document.createElement("button");cancel.textContent="취소";cancel.onclick=()=>dialog.close();
        dialog.append(text,confirm,cancel);dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
      });
    }
    const reset=document.createElement("button");reset.type="button";reset.setAttribute("role","menuitem");reset.textContent="분할 닫기";reset.onclick=()=>{state.layout=2;setLayout(2);dockRects=[{x:0,y:0,w:1,h:1}];applyDockLayout();hide();};menu.append(reset);
    menu.hidden=false;Object.assign(menu.style,{left:Math.max(8,Math.min(event.clientX,innerWidth-menu.offsetWidth-8))+"px",top:Math.max(8,Math.min(event.clientY,innerHeight-menu.offsetHeight-8))+"px"});action.focus();
  });
  document.addEventListener("pointerdown",event=>{if(!menu.contains(event.target))menu.hidden=true;});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"){pendingDock=null;hide();}});
  applyDockLayout();
}
