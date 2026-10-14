import {callReply, speechText, callLink, createSpeechGate} from "/voice-session.mjs";

export function createVoiceCall({api, getSession, getRoom, getSelection, onMessages, toast, beforeStart = () => {}}) {
  const dialog = document.createElement("dialog");
  dialog.className = "voice-call-dialog";
  dialog.setAttribute("aria-labelledby", "voice-call-title");
  dialog.innerHTML = `<div class="voice-call-top"><span>대화에 전화하기</span><button type="button" class="icon-button voice-minimize" aria-label="통화 창 접기">⌄</button></div>
    <h2 id="voice-call-title"></h2><div class="voice-call-time"></div>
    <div class="voice-orb"><svg class="icon" aria-hidden="true"><use href="#i-phone"/></svg></div>
    <div class="voice-call-status" role="status"></div><p class="voice-call-transcript"></p>
    <p class="voice-call-note">말하면 이 대화에 전송되고, 답변을 음성으로 들려드려요.<br>웹 통화 중에는 이 앱을 화면에 열어두세요.</p>
    <div class="voice-call-controls"><button type="button" class="voice-start">통화 시작</button><button type="button" class="voice-mute" hidden>마이크 끄기</button><button type="button" class="voice-send" hidden>말 끝내기</button><button type="button" class="voice-end" hidden>통화 종료</button></div>
    <button type="button" class="voice-call-link">이 대화 통화 링크 복사</button>`;
  const pill = document.createElement("button");
  pill.type = "button"; pill.className = "voice-call-pill"; pill.hidden = true;
  document.body.append(dialog, pill);
  const find = selector => dialog.querySelector(selector);
  const title = find("h2"), status = find(".voice-call-status"), transcript = find(".voice-call-transcript");
  const startButton = find(".voice-start"), muteButton = find(".voice-mute"), sendButton = find(".voice-send"), endButton = find(".voice-end");
  let target = null, active = null, nativeWait = null;
  const nativeBridge = () => window.webkit?.messageHandlers?.cloudbotCall;
  function native(action, extra = {}) {
    if (active?.native) nativeBridge()?.postMessage({action, roomId:active.roomId, roomTitle:active.title, ...extra});
  }
  const current = call => {
    if (active !== call || call.controller.signal.aborted) return false;
    if (getSession()?.user?.id !== call.userId) { end("로그인이 바뀌어 통화를 종료했어요."); return false; }
    return true;
  };
  const requestSignal = (call, milliseconds = 20000) => AbortSignal.any([call.controller.signal, AbortSignal.timeout(milliseconds)]);
  function renderStage(stage, label) {
    dialog.dataset.stage = stage; status.textContent = label;
    sendButton.disabled = stage !== "listening";
    muteButton.textContent = active?.muted ? "마이크 켜기" : "마이크 끄기";
    muteButton.setAttribute("aria-pressed", String(!!active?.muted));
    pill.textContent = `${active?.title || target?.name || "대화"} · ${label}`;
  }
  function show() { if (!dialog.open) dialog.showModal(); pill.hidden = true; }
  function minimize() { dialog.close(); pill.hidden = !active; }
  function refreshTitle(call, name) {
    if (!name || !current(call) || call.title === name) return;
    call.title = name; title.textContent = name; native("title");
  }
  function releaseCapture(call) {
    call.captureVersion = (call.captureVersion || 0) + 1;
    call.finishUtterance = null;
    clearInterval(call.vadTimer); call.vadTimer = null;
    const recorder = call.recorder; call.recorder = null;
    if (recorder) { recorder.ondataavailable = null; recorder.onerror = null; }
    if (recorder?.state === "recording") { recorder.onstop = null; try { recorder.stop(); } catch {} }
    call.source?.disconnect(); call.source = null;
    call.stream?.getTracks().forEach(track => track.stop()); call.stream = null;
  }
  function end(message = "통화가 끝났어요.", notifyNative = true) {
    const call = active;
    if (call) {
      if (notifyNative) native("end");
      active = null;
      call.controller.abort(); releaseCapture(call); clearInterval(call.clock);
      call.context?.close().catch(() => {}); window.speechSynthesis?.cancel();
      nativeWait?.reject(new Error("통화가 종료됐어요.")); nativeWait = null;
    }
    startButton.hidden = false; startButton.disabled = false; startButton.textContent = "통화 시작";
    muteButton.hidden = sendButton.hidden = endButton.hidden = true; pill.hidden = true;
    document.querySelectorAll(".voice-call-button").forEach(button => button.classList.remove("is-active"));
    renderStage("ended", message);
  }
  function fail(call, error) {
    if (!current(call)) return;
    const message = error?.name === "NotAllowedError" ? "마이크 권한을 허용한 뒤 다시 시작해 주세요." : (error.message || "통화 연결을 확인해 주세요.");
    native("failed", {message}); end(message, false); show();
  }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, {once:true});
    });
  }
  async function awaitReply(call, messageId) {
    const deadline = Date.now() + 180000;
    while (current(call) && Date.now() < deadline) {
      const data = await api(`/api/rooms/${call.roomId}`, {signal:requestSignal(call)});
      if (!current(call)) return;
      refreshTitle(call, data.room?.name);
      const reply = callReply(data, messageId);
      if (reply.state === "reply") { onMessages(call.roomId); return reply.text; }
      if (reply.state === "error") throw new Error(reply.text);
      if (reply.state === "interrupted") throw new Error("다른 메시지가 이어졌어요. 답변은 이 대화에서 확인해 주세요.");
      if (reply.state === "empty") throw new Error("음성 답변을 받지 못했어요. 대화에서 결과를 확인해 주세요.");
      await delay(1400, call.controller.signal);
    }
    if (current(call)) throw new Error("답변이 오래 걸리고 있어요. 작업 결과는 이 대화에 남습니다.");
  }
  async function speak(call, text) {
    if (!current(call)) return;
    renderStage("speaking", "답변을 들려드리고 있어요"); transcript.textContent = text;
    const content = speechText(text);
    if (!content) return;
    await new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(content);
      utterance.lang = "ko-KR";
      const voice = speechSynthesis.getVoices().find(item => item.lang.startsWith("ko"));
      if (voice) utterance.voice = voice;
      let finished = false;
      const finish = error => { if (finished) return; finished = true; clearTimeout(timeout); call.controller.signal.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
      const abort = () => { speechSynthesis.cancel(); finish(); };
      utterance.onend = () => finish();
      utterance.onerror = () => finish(new Error("소리를 재생하지 못했어요. 답변은 대화에 저장됐습니다."));
      const timeout = setTimeout(() => { speechSynthesis.cancel(); finish(new Error("음성 재생이 멈췄어요. 답변은 대화에서 확인해 주세요.")); }, 180000);
      call.controller.signal.addEventListener("abort", abort, {once:true});
      speechSynthesis.speak(utterance);
    });
  }
  async function processAudio(call, blob, mime) {
    if (!current(call)) return;
    renderStage("transcribing", "말씀을 확인하고 있어요");
    const form = new FormData();
    const extension = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
    form.append("file", blob, `call.${extension}`);
    try {
      const result = await api(`/api/rooms/${call.roomId}/voice/transcribe`, {method:"POST", body:form, signal:requestSignal(call, 55000)});
      if (!current(call)) return;
      const text = result.text?.trim();
      if (!text) { renderStage("listening", "잘 안 들렸어요. 다시 말씀해 주세요"); return await listen(call); }
      transcript.textContent = text;
      renderStage("waiting", "대화에 보내고 답변을 기다려요");
      // One nonce per utterance. A transport retry reuses it; never replay a command as a new turn.
      const body = JSON.stringify({text, clientNonce:`call:${call.id}:${++call.turn}`, botIds:call.botIds, model:call.model, effort:call.effort});
      let accepted;
      try { accepted = await api(`/api/rooms/${call.roomId}/messages`, {method:"POST", body, signal:requestSignal(call, 30000)}); }
      catch (error) {
        // Recheck the actor before retrying; a switched account must never inherit this command.
        if (!current(call) || error.status || error.name === "AbortError" || error.name === "TimeoutError") throw error;
        accepted = await api(`/api/rooms/${call.roomId}/messages`, {method:"POST", body, signal:requestSignal(call, 30000)});
      }
      if (!current(call)) return;
      if (!accepted.messageId) throw new Error("메시지 접수 결과를 확인하지 못했어요. 대화를 확인해 주세요.");
      onMessages(call.roomId);
      const answer = await awaitReply(call, accepted.messageId);
      if (!current(call)) return;
      await speak(call, answer);
      if (current(call)) await listen(call);
    } catch (error) { fail(call, error); }
  }
  async function listen(call) {
    if (!current(call) || !call.ready) return;
    releaseCapture(call);
    const captureVersion = call.captureVersion;
    const canCapture = () => current(call) && call.captureVersion === captureVersion && !call.muted;
    if (call.muted) { renderStage("muted", "마이크가 꺼져 있어요"); return; }
    renderStage("connecting", "마이크 연결 중");
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}, video:false}); }
    catch (error) { if (canCapture()) throw error; return; }
    if (!canCapture()) { stream.getTracks().forEach(track => track.stop()); return; }
    call.stream = stream;
    try { await call.context.resume(); }
    catch (error) { if (canCapture()) throw error; stream.getTracks().forEach(track => track.stop()); return; }
    if (!canCapture()) { stream.getTracks().forEach(track => track.stop()); return; }
    const source = call.context.createMediaStreamSource(stream), analyser = call.context.createAnalyser();
    analyser.fftSize = 2048; source.connect(analyser); call.source = source;
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mime ? {mimeType:mime} : undefined);
    const chunks = [], values = new Float32Array(analyser.fftSize), gate = createSpeechGate({maxMs:call.maxSeconds * 1000});
    let bytes = 0, submit = false;
    call.recorder = recorder;
    recorder.ondataavailable = event => { if (current(call) && call.recorder === recorder && event.data.size) { chunks.push(event.data); bytes += event.data.size; if (bytes > call.maxBytes) fail(call, new Error("한 번에 담을 수 있는 음성을 넘었어요. 짧게 나누어 말씀해 주세요.")); } };
    recorder.onerror = () => { if (current(call) && call.recorder === recorder) fail(call, new Error("마이크 연결이 끊겼어요. 다시 시작해 주세요.")); };
    recorder.onstop = () => {
      if (!current(call) || call.recorder !== recorder) return;
      call.recorder = null; releaseCapture(call);
      if (submit && chunks.length && bytes <= call.maxBytes) void processAudio(call, new Blob(chunks, {type:recorder.mimeType}), recorder.mimeType);
      else void listen(call).catch(error => fail(call, error));
    };
    call.finishUtterance = () => { if (!current(call) || recorder.state !== "recording") return; submit = gate.voiced; recorder.stop(); clearInterval(call.vadTimer); };
    recorder.start(400);
    call.vadTimer = setInterval(() => {
      if (!current(call)) return;
      analyser.getFloatTimeDomainData(values);
      const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
      const decision = gate.sample(rms, performance.now());
      if (decision === "send" || decision === "discard") call.finishUtterance();
    }, 60);
    renderStage("listening", "듣고 있어요");
  }
  async function start() {
    if (active || !target || !getSession()?.user) return;
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext) || !window.speechSynthesis) {
      renderStage("error", "이 브라우저에서는 통화를 지원하지 않아요. 최신 Safari 또는 Chrome을 사용해 주세요."); return;
    }
    const selection = getSelection(target.id);
    if (!selection.botIds?.length) { renderStage("error", "응답할 봇 연결을 먼저 확인해 주세요."); return; }
    beforeStart();
    const call = {id:crypto.randomUUID(), roomId:target.id, title:target.name, userId:getSession().user.id, controller:new AbortController(), turn:0, muted:false, ready:false, native:!!nativeBridge(), ...selection};
    active = call;
    if (!call.native) {
      call.context = new (window.AudioContext || window.webkitAudioContext)();
      // Unlock browser output during Start; native audio waits for CallKit activation.
      void call.context.resume().catch(() => {});
      const unlock = new SpeechSynthesisUtterance(" "); speechSynthesis.speak(unlock);
    }
    startButton.hidden = true; muteButton.hidden = sendButton.hidden = endButton.hidden = false;
    document.querySelectorAll(".voice-call-button").forEach(button => button.classList.add("is-active"));
    renderStage("connecting", "통화를 연결하고 있어요");
    try {
      const [capability, data] = await Promise.all([api("/api/voice", {signal:requestSignal(call)}), api(`/api/rooms/${call.roomId}`, {signal:requestSignal(call)})]);
      if (!current(call)) return;
      if (!capability.configured) throw new Error("음성 인식 연결이 필요해요. 내 봇 설정에서 Groq 키를 확인해 주세요.");
      if (data.busy) throw new Error("이 대화의 작업이 끝나면 통화를 시작해 주세요.");
      call.maxSeconds = Math.min(30, Number(capability.maxSeconds) || 30); call.maxBytes = Math.min(10 * 1024 * 1024, Number(capability.maxBytes) || 10 * 1024 * 1024);
      refreshTitle(call, data.room?.name);
      if (call.native) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { nativeWait = null; reject(new Error("아이폰 통화 연결 시간이 초과됐어요.")); }, 15000);
          nativeWait = {roomId:call.roomId, resolve:() => { clearTimeout(timer); resolve(); }, reject:error => { clearTimeout(timer); reject(error); }};
          native("start");
        });
      }
      if (!current(call)) return;
      call.context ??= new (window.AudioContext || window.webkitAudioContext)();
      call.ready = true;
      await listen(call);
      if (!current(call)) return;
      native("connected");
      call.startedAt = Date.now();
      call.clock = setInterval(() => { if (!current(call)) return; const seconds = Math.floor((Date.now() - call.startedAt) / 1000); find(".voice-call-time").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,"0")}`; }, 1000);
    } catch (error) { fail(call, error); }
  }
  function open(room) {
    if (active) { show(); if (room?.id !== active.roomId) toast(`현재 통화는 ‘${active.title}’에 연결되어 있어요.`); return; }
    if (!room || room.archived || room.id === "00000000-0000-4000-8000-000000000001") { toast("전화할 대화를 먼저 선택해 주세요."); return; }
    target = {id:room.id, name:room.name}; title.textContent = room.name; transcript.textContent = ""; find(".voice-call-time").textContent = "이 대화의 이전 내용을 이어서 통화합니다";
    renderStage("ready", "이 대화로 연결할까요?"); show();
  }
  startButton.onclick = () => void start();
  endButton.onclick = () => end();
  sendButton.onclick = () => active?.finishUtterance?.();
  function setMuted(muted) {
    if (!active) return;
    active.muted = muted;
    if (active.ready && active.muted && ["listening", "connecting"].includes(dialog.dataset.stage)) { releaseCapture(active); renderStage("muted", "마이크가 꺼져 있어요"); }
    else if (active.ready && !active.muted && dialog.dataset.stage === "muted") { const call = active; void listen(call).catch(error => fail(call,error)); }
    muteButton.textContent = active.muted ? "마이크 켜기" : "마이크 끄기"; muteButton.setAttribute("aria-pressed",String(active.muted));
  }
  muteButton.onclick = () => { if (active) setMuted(!active.muted); };
  find(".voice-minimize").onclick = minimize; pill.onclick = show;
  dialog.addEventListener("cancel", event => { event.preventDefault(); minimize(); });
  find(".voice-call-link").onclick = async () => { try { await navigator.clipboard.writeText(callLink(location.origin, active?.roomId || target.id)); toast("통화 링크를 복사했어요. 대화 참여자만 연결할 수 있어요."); } catch { toast("링크를 복사하지 못했어요."); } };
  window.addEventListener("pagehide", () => end());
  document.addEventListener("visibilitychange", () => {
    // Browsers suspend timers/audio in the background: never keep a hidden microphone active.
    if (document.hidden && active) { end("앱이 화면에서 벗어나 통화를 종료했어요. 다시 시작해 주세요."); }
  });
  window.addEventListener("cloudbot:native-call", event => {
    const detail = event.detail;
    if (!active?.native || detail?.roomId !== active.roomId) return;
    if (detail.action === "active") { nativeWait?.resolve(); nativeWait = null; }
    if (detail.action === "muted" || detail.action === "unmuted") setMuted(detail.action === "muted");
    if (detail.action === "ended" || detail.action === "error") { nativeWait?.reject(new Error(detail.message || "통화가 종료됐어요.")); nativeWait = null; end(detail.message || "통화가 끝났어요.", false); }
  });
  return {open, reset:() => { end(); dialog.close(); target = null; transcript.textContent = ""; }, get roomId() { return active?.roomId || null; }, handleLink() {
    const url = new URL(location.href);
    if (url.searchParams.get("call") !== "1" || !getSession()?.user) return;
    const room = getRoom(url.searchParams.get("room"));
    url.searchParams.delete("call"); history.replaceState(null,"",url);
    if (room) open(room); else toast("이 통화 대화에 참여한 계정으로 로그인해 주세요.");
  }};
}
