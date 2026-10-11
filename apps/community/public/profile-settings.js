export const PROFILE_COLORS = Object.freeze([
  {value: "#6f658e", label: "라벤더"}, {value: "#b55781", label: "로즈"},
  {value: "#427f80", label: "청록"}, {value: "#5479ad", label: "블루"},
  {value: "#9b7546", label: "샌드"}, {value: "#737373", label: "그레이"},
]);
function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
export function createProfileSettings({api, getSession, onSaved, toast}) {
  let dialog, generation = 0;
  function close() {
    generation += 1;
    if (dialog?.open) dialog.close();
    dialog?.replaceChildren();
  }
  function open() {
    const user = getSession()?.user;
    if (!user) return;
    close();
    const active = generation, userId = user.id;
    if (!dialog) {
      dialog = element("dialog", "profile-settings-dialog");
      dialog.setAttribute("aria-labelledby", "profile-settings-title");
      dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
      document.body.append(dialog);
    }
    const current = () => active === generation && dialog.open && getSession()?.user?.id === userId;
    const form = element("form", "profile-settings-form");
    const header = element("header", "profile-settings-header");
    const title = element("h2", "", "프로필 커스터마이징"); title.id = "profile-settings-title";
    const exit = element("button", "icon-button", "×"); exit.type = "button"; exit.setAttribute("aria-label", "프로필 설정 닫기"); exit.addEventListener("click", close);
    header.append(title, exit);
    const preview = element("div", "profile-settings-preview"); preview.setAttribute("aria-hidden", "true");
    const nameLabel = element("label", "profile-settings-field", "표시 이름");
    const name = element("input"); name.name = "displayName"; name.maxLength = 80; name.required = true; name.autocomplete = "nickname"; name.value = user.displayName || user.username;
    nameLabel.append(name);
    const palette = element("fieldset", "profile-settings-palette"); palette.append(element("legend", "", "프로필 색상"));
    let color = PROFILE_COLORS.some(item => item.value === user.avatarColor) ? user.avatarColor : PROFILE_COLORS[0].value;
    function renderPreview() { preview.textContent = (name.value.trim() || user.username).slice(0, 1); preview.style.backgroundColor = color; }
    name.addEventListener("input", renderPreview);
    for (const item of PROFILE_COLORS) {
      const label = element("label", "profile-settings-swatch"); label.style.setProperty("--profile-color", item.value); label.title = item.label;
      const radio = element("input"); radio.type = "radio"; radio.name = "avatarColor"; radio.value = item.value; radio.checked = color === item.value; radio.setAttribute("aria-label", item.label);
      radio.addEventListener("change", () => { color = item.value; renderPreview(); });
      label.append(radio, element("span")); palette.append(label);
    }
    const account = element("p", "profile-settings-account", "아이디 · " + user.username);
    const status = element("p", "profile-settings-status"); status.setAttribute("role", "status");
    const save = element("button", "primary-button", "저장"); save.type = "submit";
    form.append(header, preview, nameLabel, palette, account, status, save);
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (!current() || save.disabled) return;
      save.disabled = true; status.textContent = "";
      try {
        const result = await api("/api/profile", {method: "POST", body: JSON.stringify({displayName: name.value.trim(), avatarColor: color})});
        if (!current()) return;
        onSaved?.(result.user); close(); toast?.("프로필을 저장했습니다.");
      } catch (error) { if (current()) { status.textContent = error.message || "프로필을 저장하지 못했습니다."; save.disabled = false; } }
    });
    renderPreview(); dialog.append(form); dialog.showModal(); name.focus();
  }
  return {open, close, destroy() { close(); dialog?.remove(); dialog = null; }};
}
