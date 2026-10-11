/** Constrain a popup to the current viewport, including after a monitor resize. */
export function workspaceBounds(value = {}, viewport = {}, offset = 0) {
  const vw = Math.max(240, Number(viewport.width) || 1024), vh = Math.max(240, Number(viewport.height) || 768);
  const margin = 8, maxWidth = vw - margin * 2, maxHeight = vh - margin * 2;
  const width = Math.min(maxWidth, Math.max(Math.min(360, maxWidth), Number(value.width) || Math.min(920, vw * .78)));
  const height = Math.min(maxHeight, Math.max(Math.min(280, maxHeight), Number(value.height) || Math.min(640, vh * .78)));
  const left = Math.max(margin, Math.min(vw - width - margin, Number.isFinite(value.left) ? value.left : vw - width - 24 - offset));
  const top = Math.max(margin, Math.min(vh - height - margin, Number.isFinite(value.top) ? value.top : 100 + offset));
  return {left, top, width, height};
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
      entry = {open: false, window: createWindow(roomId, {index: rooms.size, onClose: () => closeRoom(roomId)})};
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
