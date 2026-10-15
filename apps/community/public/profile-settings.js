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
  let dialog, generation = 0, cleanupPhoto = () => {};
  function close() {
    generation += 1;
    cleanupPhoto(); cleanupPhoto = () => {};
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
    const title = element("h2", "", "프로필 꾸미기"); title.id = "profile-settings-title";
    const exit = element("button", "icon-button", "×"); exit.type = "button"; exit.setAttribute("aria-label", "프로필 설정 닫기"); exit.addEventListener("click", close);
    header.append(title, exit);
    const preview = element("div", "profile-settings-preview"); preview.setAttribute("aria-hidden", "true");
    let photoUrl = user.avatarUrl || "", photoFile = null, removePhoto = false, blobUrl = "", photoGeneration = 0;
    cleanupPhoto = () => { photoGeneration += 1; if (blobUrl) URL.revokeObjectURL(blobUrl); };
    const photoControls = element("div", "profile-settings-photo-controls");
    const photoInput = element("input"); photoInput.type = "file"; photoInput.accept = "image/png,image/jpeg,image/webp"; photoInput.hidden = true; photoInput.setAttribute("aria-label", "프로필 사진 파일");
    const choosePhoto = element("button", "secondary-button", "사진 올리기"); choosePhoto.type = "button"; choosePhoto.addEventListener("click", () => photoInput.click());
    const clearPhoto = element("button", "secondary-button", "사진 지우기"); clearPhoto.type = "button";
    const photoHint = element("small", "profile-settings-hint", "PNG · JPEG · WebP, 2MB 이하");
    photoControls.append(photoInput, choosePhoto, clearPhoto, photoHint);
    const nameLabel = element("label", "profile-settings-field", "표시 이름");
    const name = element("input"); name.name = "displayName"; name.maxLength = 80; name.required = true; name.autocomplete = "nickname"; name.value = user.displayName || user.username;
    nameLabel.append(name);
    const avatarLabel = element("label", "profile-settings-field", "프로필 아이콘");
    const avatar = element("input"); avatar.name = "avatarLabel"; avatar.maxLength = 64; avatar.value = user.avatarLabel || ""; avatar.placeholder = "예: 민우, MW, ☁️"; avatar.autocomplete = "off"; avatar.setAttribute("aria-describedby", "profile-avatar-help");
    const avatarHelp = element("small", "profile-settings-hint", "글자나 이모지 3개까지 · 비워두면 이름 첫 글자를 표시합니다."); avatarHelp.id = "profile-avatar-help";
    avatarLabel.append(avatar, avatarHelp);
    const palette = element("fieldset", "profile-settings-palette"); palette.append(element("legend", "", "프로필 색상"));
    let color = PROFILE_COLORS.some(item => item.value === user.avatarColor) ? user.avatarColor : PROFILE_COLORS[0].value;
    const graphemes = new Intl.Segmenter("ko", {granularity: "grapheme"});
    function renderPreview() {
      const label = avatar.value.trim().normalize("NFC");
      const count = [...graphemes.segment(label)].length;
      avatar.setCustomValidity(count > 3 || /[\p{Cc}\p{Bidi_Control}]/u.test(avatar.value) ? "글자나 이모지를 3개까지 입력해 주세요." : "");
      preview.replaceChildren();
      if (photoUrl) { const image = element("img"); image.src = photoUrl; image.alt = ""; preview.append(image); }
      else preview.textContent = label || [...graphemes.segment(name.value.trim() || user.username)][0]?.segment || "";
      preview.classList.toggle("profile-settings-preview-text", count > 1);
      preview.style.backgroundColor = color;
      clearPhoto.hidden = !photoUrl;
    }
    name.addEventListener("input", renderPreview);
    avatar.addEventListener("input", renderPreview);
    for (const item of PROFILE_COLORS) {
      const label = element("label", "profile-settings-swatch"); label.style.setProperty("--profile-color", item.value); label.title = item.label;
      const radio = element("input"); radio.type = "radio"; radio.name = "avatarColor"; radio.value = item.value; radio.checked = color === item.value; radio.setAttribute("aria-label", item.label);
      radio.addEventListener("change", () => { color = item.value; renderPreview(); });
      label.append(radio, element("span")); palette.append(label);
    }
    const account = element("p", "profile-settings-account", "아이디 · " + user.username);
    const status = element("p", "profile-settings-status"); status.setAttribute("role", "status");
    const save = element("button", "primary-button", "저장"); save.type = "submit";
    photoInput.addEventListener("change", async () => {
      const file = photoInput.files?.[0]; photoInput.value = "";
      if (!file || !current() || save.disabled) return;
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > 2 * 1024 * 1024) { status.textContent = "2MB 이하의 PNG, JPEG 또는 WebP 사진을 선택해 주세요."; return; }
      const nextUrl = URL.createObjectURL(file), activePhoto = ++photoGeneration;
      save.disabled = true; choosePhoto.disabled = true; clearPhoto.disabled = true;
      try {
        const image = new Image();
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = nextUrl; });
        if (!current() || activePhoto !== photoGeneration) { URL.revokeObjectURL(nextUrl); return; }
        if (!image.naturalWidth || image.naturalWidth > 4096 || image.naturalHeight > 4096) throw new Error("사진의 가로와 세로는 4096px 이하여야 합니다.");
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrl = nextUrl; photoUrl = nextUrl; photoFile = file; removePhoto = false; status.textContent = ""; renderPreview();
      } catch (error) { URL.revokeObjectURL(nextUrl); if (current() && activePhoto === photoGeneration) status.textContent = error.message || "사진을 읽지 못했습니다. 다른 파일을 선택해 주세요."; }
      finally { if (current() && activePhoto === photoGeneration) { save.disabled = false; choosePhoto.disabled = false; clearPhoto.disabled = false; } }
    });
    clearPhoto.addEventListener("click", () => {
      photoGeneration += 1; if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = ""; photoUrl = ""; photoFile = null; removePhoto = true; renderPreview();
    });
    form.append(header, preview, photoControls, nameLabel, avatarLabel, palette, account, status, save);
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (!current() || save.disabled) return;
      save.disabled = true; choosePhoto.disabled = true; clearPhoto.disabled = true; status.textContent = "";
      try {
        if (photoFile || removePhoto) {
          const upload = new FormData(); if (photoFile) upload.append("file", photoFile);
          const photoResult = await api("/api/profile/avatar", {method: photoFile ? "POST" : "DELETE", ...(photoFile ? {body: upload} : {})});
          if (!current()) return;
          onSaved?.(photoResult.user); photoFile = null; removePhoto = false;
        }
        const result = await api("/api/profile", {method: "POST", body: JSON.stringify({displayName: name.value.trim(), avatarColor: color, avatarLabel: avatar.value.trim()})});
        if (!current()) return;
        onSaved?.(result.user); close(); toast?.("프로필을 저장했습니다.");
      } catch (error) { if (current()) { status.textContent = error.message || "프로필을 저장하지 못했습니다."; save.disabled = false; choosePhoto.disabled = false; clearPhoto.disabled = false; } }
    });
    renderPreview(); dialog.append(form); dialog.showModal(); name.focus();
  }
  return {open, close, destroy() { close(); dialog?.remove(); dialog = null; }};
}
