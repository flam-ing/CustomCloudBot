// Navigation: participant order, conversation row captions, the row menu,
// the phone drawer and the participants sheet. Pure helpers come first so
// they can be tested without a browser.

const ROLE_RANK = { owner: 0, admin: 1 };
const collator = new Intl.Collator("ko", { sensitivity: "base", numeric: true });
const memberName = (member) => String(member?.displayName || member?.username || "").trim();

export function memberRoleLabel(role) {
  return role === "owner" ? "방장" : role === "admin" ? "관리자" : "멤버";
}

/** Owner first, then admins, then everyone else; names in Korean dictionary order. */
export function sortMembers(members = []) {
  return (Array.isArray(members) ? members : [])
    .filter((member) => member && typeof member === "object")
    .map((member, index) => ({ member, index }))
    .sort((a, b) =>
      (ROLE_RANK[a.member.role] ?? 2) - (ROLE_RANK[b.member.role] ?? 2) ||
      collator.compare(memberName(a.member), memberName(b.member)) ||
      a.index - b.index)
    .map(({ member }) => member);
}

export function filterMembers(members = [], query = "") {
  const needle = String(query).trim().toLocaleLowerCase("ko");
  if (!needle) return members;
  return members.filter((member) => memberName(member).toLocaleLowerCase("ko").includes(needle));
}

/** The second line of a conversation row: what it grew from, or who is in it. */
export function branchRowMeta({ operation = "root", parentNames = [], room = {} } = {}) {
  const parts = [];
  if (room.pinned) parts.push("고정");
  if (operation === "fork" || operation === "merge") {
    const relation = operation === "merge" ? "Merge" : "Fork";
    const names = parentNames.filter(Boolean);
    parts.push(names.length ? `${relation} · ${names.join(" + ")}` : relation);
  } else {
    const description = String(room.description || "").trim();
    const count = Number(room.memberCount);
    if (room.personal) parts.push(description || "나만의 대화");
    else {
      if (Number.isFinite(count) && count > 0) parts.push(`참여자 ${count}명`);
      if (description) parts.push(description);
    }
  }
  return parts.join(" · ");
}

/** Index of the menu item that an arrow, Home or End key moves to. */
export function nextMenuIndex(current, key, count) {
  if (!count) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count;
  if (key === "ArrowUp") return current < 0 ? count - 1 : (current - 1 + count) % count;
  return current;
}

/** Where a popup menu goes next to its button or pointer, kept inside the window. */
export function placeMenu(anchor, size, viewport, gap = 4, margin = 8) {
  const { width, height } = size;
  const maxLeft = Math.max(margin, viewport.width - width - margin);
  const maxTop = Math.max(margin, viewport.height - height - margin);
  const clamp = (value, max) => Math.round(Math.max(margin, Math.min(value, max)));
  // A point (right-click) opens the menu at the pointer; a box (a button) opens it below.
  if (!("bottom" in anchor)) return { left: clamp(anchor.x, maxLeft), top: clamp(anchor.y, maxTop) };
  const below = anchor.bottom + gap, above = anchor.top - gap - height;
  const top = below + height <= viewport.height - margin || above < margin ? below : above;
  return { left: clamp(anchor.right - width, maxLeft), top: clamp(top, maxTop) };
}

/** Moves focus between menu items with the arrow keys, Home and End. */
export function handleMenuKeys(event, container, selector = '[role="menuitem"]:not(:disabled)') {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return false;
  const items = [...container.querySelectorAll(selector)].filter((item) => item.offsetParent !== null || item.getClientRects().length);
  const index = items.indexOf(document.activeElement);
  const next = items[nextMenuIndex(index, event.key, items.length)];
  if (!next) return false;
  event.preventDefault();
  next.focus();
  return true;
}

let menuIds = 0;

/**
 * A popup menu for a conversation. It sits in the top layer when the browser
 * supports popovers, so it shows above the drawer. On phones it becomes a
 * sheet at the bottom of the screen.
 */
export function createMenu({ className = "nav-menu", sheetQuery = "(max-width: 720px)" } = {}) {
  const menu = document.createElement("div");
  const popover = typeof menu.showPopover === "function";
  menu.className = className;
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  if (popover) menu.popover = "manual";
  document.body.append(menu);
  const sheet = matchMedia(sheetQuery);
  let trigger = null, onClose = null;

  function close({ restoreFocus = true } = {}) {
    if (menu.hidden) return;
    if (popover && menu.matches(":popover-open")) menu.hidePopover();
    menu.hidden = true;
    menu.classList.remove("is-sheet");
    const back = trigger, done = onClose;
    trigger = null; onClose = null;
    if (back?.hasAttribute("aria-haspopup")) back.setAttribute("aria-expanded", "false");
    if (restoreFocus && back?.isConnected) back.focus({ preventScroll: true });
    done?.();
  }

  function open({ items = [], anchor = null, from = null, title = "", onClose: closed = null } = {}) {
    close({ restoreFocus: false });
    menu.replaceChildren();
    menu.removeAttribute("aria-labelledby");
    const asSheet = sheet.matches;
    menu.classList.toggle("is-sheet", asSheet);
    if (title) {
      const heading = document.createElement("p");
      heading.className = "nav-menu-title";
      heading.id = `nav-menu-title-${++menuIds}`;
      heading.textContent = title;
      menu.setAttribute("aria-labelledby", heading.id);
      menu.append(heading);
    } else if (from?.getAttribute("aria-label")) menu.setAttribute("aria-label", from.getAttribute("aria-label"));
    for (const entry of items) {
      if (!entry) continue;
      if (entry.separator) {
        const line = document.createElement("div");
        line.className = "nav-menu-separator";
        line.setAttribute("role", "separator");
        menu.append(line);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = `nav-menu-item${entry.danger ? " is-danger" : ""}`;
      button.setAttribute("role", "menuitem");
      button.textContent = entry.label;
      button.disabled = Boolean(entry.disabled);
      button.addEventListener("click", () => {
        close({ restoreFocus: entry.restoreFocus !== false });
        entry.run?.();
      });
      menu.append(button);
    }
    trigger = from;
    onClose = closed;
    menu.hidden = false;
    if (popover) menu.showPopover();
    if (asSheet) {
      menu.style.left = "";
      menu.style.top = "";
    } else {
      const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
      const spot = placeMenu(rect || { x: 8, y: 8 }, { width: menu.offsetWidth, height: menu.offsetHeight }, { width: innerWidth, height: innerHeight });
      menu.style.left = `${spot.left}px`;
      menu.style.top = `${spot.top}px`;
    }
    if (trigger?.hasAttribute("aria-haspopup")) trigger.setAttribute("aria-expanded", "true");
    menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }

  menu.addEventListener("keydown", (event) => {
    if (handleMenuKeys(event, menu)) return;
    if (event.key === "Tab") close();
  });
  // Escape closes the menu first, wherever focus is, before anything behind it.
  document.addEventListener("keydown", (event) => {
    if (menu.hidden || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }, true);
  // The sheet's backdrop belongs to the menu element, so a press there is
  // recognised by position rather than by the event target.
  document.addEventListener("pointerdown", (event) => {
    // A press on the ⋯ button itself is left to its click, which toggles the menu.
    if (menu.hidden || (trigger?.hasAttribute("aria-haspopup") && trigger.contains(event.target))) return;
    const r = menu.getBoundingClientRect();
    const inside = event.target !== menu ? menu.contains(event.target)
      : event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    if (!inside) close({ restoreFocus: false });
  }, true);
  addEventListener("resize", () => close({ restoreFocus: false }));
  document.addEventListener("scroll", (event) => {
    if (!menu.hidden && !menu.classList.contains("is-sheet") && !menu.contains(event.target)) close({ restoreFocus: false });
  }, true);

  return { element: menu, open, close, isOpen: () => !menu.hidden, trigger: () => trigger };
}

/**
 * The phone drawer (conversation list) and the participants sheet. Only one
 * covers the screen at a time; whatever sits behind it is inert while it is
 * open, and focus returns to the button that opened it.
 */
export function createNavigationShell({ workspace, sidebar, sidebarScrim, main, memberPanel, memberScrim, toggle, mobileQuery = "(max-width: 720px)", wideQuery = "(min-width: 1180px)" }) {
  const mobile = matchMedia(mobileQuery), wide = matchMedia(wideQuery);
  let drawerOpener = null, membersOpener = null;
  const drawerOpen = () => mobile.matches && sidebar.classList.contains("is-open");
  const membersOpen = () => memberPanel.classList.contains("is-open");
  const membersModal = () => membersOpen() && !wide.matches;

  function syncToggle() {
    const expanded = mobile.matches ? drawerOpen() : !workspace.classList.contains("sidebar-collapsed");
    toggle.setAttribute("aria-expanded", String(expanded));
  }
  function sync() {
    const drawer = drawerOpen(), sheet = membersModal();
    sidebarScrim.classList.toggle("is-visible", drawer);
    memberScrim.classList.toggle("is-visible", sheet);
    workspace.classList.toggle("members-open", membersOpen());
    workspace.classList.toggle("drawer-open", drawer);
    main.inert = drawer || sheet;
    sidebar.inert = sheet;
    memberPanel.inert = drawer;
    // Over the page it behaves as a dialog; as a column it is a side region.
    if (sheet) { memberPanel.setAttribute("role", "dialog"); memberPanel.setAttribute("aria-modal", "true"); }
    else { memberPanel.removeAttribute("role"); memberPanel.removeAttribute("aria-modal"); }
    document.querySelectorAll('[aria-controls="member-panel"]').forEach((button) => button.setAttribute("aria-expanded", String(membersOpen())));
    syncToggle();
  }
  function focusInto(container, preferred) {
    const move = () => {
      const target = preferred.map((selector) => selector === ":scope" ? container : container.querySelector(selector)).find((element) => element && !element.disabled && element.getClientRects().length);
      target?.focus({ preventScroll: false });
      return Boolean(target) && container.contains(document.activeElement);
    };
    // The panel may still be turning visible this frame; try again on the next.
    if (!move()) requestAnimationFrame(() => { if (!container.contains(document.activeElement)) move(); });
  }

  // From the keyboard, focus lands on the first useful control. From a tap it
  // lands on the panel itself, so no focus ring flashes on a row.
  function openDrawer({ keyboard = false } = {}) {
    if (!mobile.matches) return;
    closeMembers({ restoreFocus: false });
    drawerOpener = document.activeElement instanceof HTMLElement && !sidebar.contains(document.activeElement) ? document.activeElement : toggle;
    sidebar.classList.add("is-open");
    sync();
    focusInto(sidebar, keyboard ? [".branch-row.is-selected", "#create-room-button", "#mobile-close"] : [":scope"]);
  }
  function closeDrawer({ restoreFocus = true } = {}) {
    const wasOpen = sidebar.classList.contains("is-open");
    // Focus counts as inside when it was there, or was lost to the page by a tap on the scrim.
    const hadFocus = sidebar.contains(document.activeElement) || !document.activeElement || document.activeElement === document.body;
    sidebar.classList.remove("is-open");
    sync();
    const back = drawerOpener; drawerOpener = null;
    if (wasOpen && restoreFocus && hadFocus) (back?.isConnected && back.getClientRects().length ? back : toggle).focus({ preventScroll: true });
  }
  function toggleSidebar(options) {
    if (mobile.matches) { if (drawerOpen()) closeDrawer(); else openDrawer(options); return; }
    workspace.classList.toggle("sidebar-collapsed");
    syncToggle();
  }

  function openMembers(from = document.activeElement, { keyboard = false } = {}) {
    closeDrawer({ restoreFocus: false });
    membersOpener = from instanceof HTMLElement ? from : null;
    memberPanel.classList.add("is-open");
    sync();
    focusInto(memberPanel, keyboard ? ["#member-close"] : [":scope"]);
  }
  function closeMembers({ restoreFocus = true } = {}) {
    if (!membersOpen()) return;
    const hadFocus = memberPanel.contains(document.activeElement);
    memberPanel.classList.remove("is-open");
    sync();
    const back = membersOpener; membersOpener = null;
    if (restoreFocus && (hadFocus || document.activeElement === document.body) && back?.isConnected && back.getClientRects().length) back.focus({ preventScroll: true });
  }
  function toggleMembers(from, options) { if (membersOpen()) closeMembers(); else openMembers(from, options); }

  /** Escape closes the sheet on top first, then the drawer. */
  function escape() {
    if (membersOpen()) { closeMembers(); return true; }
    if (drawerOpen()) { closeDrawer(); return true; }
    return false;
  }

  sidebarScrim.addEventListener("click", () => closeDrawer());
  memberScrim.addEventListener("click", () => closeMembers());
  // A press outside a narrow-screen sheet closes it, like the drawer scrim.
  document.addEventListener("pointerdown", (event) => {
    if (!membersModal() || memberPanel.contains(event.target) || event.target.closest?.('[aria-controls="member-panel"], dialog, [popover]')) return;
    if (event.target === memberScrim) return;
    closeMembers({ restoreFocus: false });
  });
  mobile.addEventListener("change", () => { if (!mobile.matches) sidebar.classList.remove("is-open"); sync(); });
  wide.addEventListener("change", sync);

  // A swipe toward the edge closes the drawer. Dragging a conversation does not count.
  let swipe = null;
  sidebar.addEventListener("touchstart", (event) => {
    swipe = event.touches.length === 1 && drawerOpen() ? { x: event.touches[0].clientX, y: event.touches[0].clientY, dragging: false } : null;
  }, { passive: true });
  sidebar.addEventListener("touchmove", () => { if (swipe && document.body.classList.contains("session-dragging")) swipe.dragging = true; }, { passive: true });
  sidebar.addEventListener("touchend", (event) => {
    const start = swipe; swipe = null;
    const touch = event.changedTouches[0];
    if (!start || start.dragging || !touch) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (dx < -64 && Math.abs(dy) < Math.abs(dx) * 0.6) closeDrawer();
  }, { passive: true });

  sync();
  return { openDrawer, closeDrawer, toggleSidebar, syncToggle, openMembers, closeMembers, toggleMembers, escape, drawerOpen, membersOpen, sync };
}
