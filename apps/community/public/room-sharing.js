function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
export function createRoomSharing({api, getSession, onRoomCreated, onInvite, toast}) {
  let dialog, generation = 0;
  function close() { generation += 1; if (dialog?.open) dialog.close(); dialog?.replaceChildren(); }
  function open(room) {
    const user = getSession()?.user;
    if (!user || !room) return;
    close();
    if (room.sharing?.canInvite ?? (!room.personal && room.role === "owner")) { onInvite?.(room); return; }
    if (!(room.sharing?.canCreateSharedCopy ?? (room.personal && room.role === "owner"))) { toast?.("대화 소유자만 초대할 수 있습니다."); return; }
    const active = generation, userId = user.id;
    if (!dialog) {
      dialog = element("dialog", "room-sharing-dialog"); dialog.setAttribute("aria-labelledby", "room-sharing-title");
      dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
      document.body.append(dialog);
    }
    const current = () => active === generation && dialog.open && getSession()?.user?.id === userId;
    const form = element("form", "room-sharing-form"), header = element("header", "room-sharing-header");
    const title = element("h2", "", "함께 대화하기"); title.id = "room-sharing-title";
    const exit = element("button", "icon-button", "×"); exit.type = "button"; exit.setAttribute("aria-label", "공유 설정 닫기"); exit.addEventListener("click", close);
    header.append(title, exit);
    const explanation = element("p", "room-sharing-copy", "개인 대화를 그대로 보관하고, 여러 명이 참여할 새 세션을 만듭니다.");
    const nameLabel = element("label", "room-sharing-field", "함께 쓸 대화 이름");
    const name = element("input"); name.name = "name"; name.required = true; name.maxLength = 80; name.value = room.name.slice(0, 65) + " · 함께 대화"; nameLabel.append(name);
    const historyLabel = element("label", "room-sharing-history");
    const history = element("input"); history.type = "checkbox"; history.name = "includeHistory"; history.checked = false;
    historyLabel.append(history, element("span", "", "이전 메시지와 첨부 파일도 복사"));
    const note = element("p", "room-sharing-note", "이 옵션을 켜면 기존 메일·캘린더 조회 결과 등 대화에 남아 있는 내용도 참여자에게 보입니다. 개인 연결 서비스 접근 권한은 복사하지 않습니다.");
    const status = element("p", "room-sharing-status"); status.setAttribute("role", "status");
    const submit = element("button", "primary-button", "세션 만들고 초대 링크 받기"); submit.type = "submit";
    form.append(header, explanation, nameLabel, historyLabel, note, status, submit);
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
    dialog.append(form); dialog.showModal(); name.focus();
  }
  return {open, close, destroy() { close(); dialog?.remove(); dialog = null; }};
}
