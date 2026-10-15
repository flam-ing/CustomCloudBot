export const CASCADE_STEP = 28;
export const WORKSPACE_LAYER_SPAN = 10;

/**
 * Constrain a popup to the current viewport, including after a monitor resize.
 * A new window (no saved height) stops above the composer: `reserveBottom` is
 * the space the composer occupies at the bottom of the viewport.
 */
export function workspaceBounds(value = {}, viewport = {}, offset = 0, reserveBottom = 0) {
  const vw = Math.max(240, Number(viewport.width) || 1024), vh = Math.max(240, Number(viewport.height) || 768);
  const margin = 8, maxWidth = vw - margin * 2, maxHeight = vh - margin * 2;
  const defaultTop = 64 + offset;
  const fit = Number(reserveBottom) > 0 ? vh - defaultTop - Number(reserveBottom) - 12 : Infinity;
  const defaultHeight = Math.min(640, vh * .78, Math.max(280, fit));
  const width = Math.min(maxWidth, Math.max(Math.min(360, maxWidth), Number(value.width) || Math.min(920, vw * .78)));
  const height = Math.min(maxHeight, Math.max(Math.min(280, maxHeight), Number(value.height) || defaultHeight));
  const left = Math.max(margin, Math.min(vw - width - margin, Number.isFinite(value.left) ? value.left : vw - width - 24 - offset));
  const top = Math.max(margin, Math.min(vh - height - margin, Number.isFinite(value.top) ? value.top : defaultTop));
  return {left, top, width, height};
}

/** The lowest cascade position no open window is using, so a new window never lands on an older one. */
export function freeCascadeSlot(used = []) {
  const taken = new Set(used);
  let slot = 0;
  while (taken.has(slot)) slot++;
  return slot;
}

/**
 * Stacking order inside the workspace layer band (30-39 by default). The most
 * recently raised window is last and gets the highest value; values never leave
 * the band, so drawers, toasts and dialogs stay above every window.
 */
export function workspaceLayers(count, span = WORKSPACE_LAYER_SPAN) {
  return Array.from({length: Math.max(0, count)}, (_, index) => Math.max(0, Math.min(span - 1, index - Math.max(0, count - span))));
}

/** Room navigation changes the target; only an explicit open creates a window. */
export function createWorkspaceWindows({createWindow, maxOpen = 6, onLimit = () => {}, onChange = () => {}}) {
  const rooms = new Map();
  let selected = null, destroyed = false;
  const notify = () => onChange({roomId: selected, open: !!rooms.get(selected)?.open});
  const closeRoom = roomId => {
    const entry = rooms.get(roomId);
    if (!entry?.open) return;
    entry.open = false;
    entry.window.close();
    notify();
  };
  const openRoom = roomId => {
    if (destroyed || !roomId) return false;
    let entry = rooms.get(roomId);
    if (!entry?.open && [...rooms.values()].filter(item => item.open).length >= maxOpen) {onLimit(); return false;}
    if (!entry) {
      // Retain a few closed windows so reopening preserves each room's view/geometry.
      if (rooms.size >= 24) {
        const oldest = [...rooms].find(([, item]) => !item.open);
        if (oldest) {oldest[1].window.destroy(); rooms.delete(oldest[0]);}
      }
      const slot = freeCascadeSlot([...rooms.values()].filter(item => item.open).map(item => item.slot));
      entry = {open: false, slot, window: createWindow(roomId, {index: slot, onClose: () => closeRoom(roomId)})};
      rooms.set(roomId, entry);
    }
    entry.open = true;
    entry.window.open();
    notify();
    return true;
  };
  const reset = () => {
    selected = null;
    for (const entry of rooms.values()) entry.window.destroy();
    rooms.clear();
    notify();
  };
  return {
    setRoom(roomId) {if (!destroyed) {selected = roomId || null; notify();}},
    openRoom(roomId = selected) {return openRoom(roomId);},
    closeRoom,
    toggle() {if (rooms.get(selected)?.open) closeRoom(selected); else openRoom(selected);},
    reset,
    destroy() {if (!destroyed) {reset(); destroyed = true;}},
  };
}
