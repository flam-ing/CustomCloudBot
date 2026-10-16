// A room's UUID supplies its random-looking seed. Pane order, titles and refreshes
// never change its color. Forks share a family, with enough separation to tell
// adjacent branches apart rather than merely tinting them a degree or two.
function hash(value) {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 0x01000193);
  }
  result ^= result >>> 16;
  result = Math.imul(result, 0x85ebca6b);
  result ^= result >>> 13;
  result = Math.imul(result, 0xc2b2ae35);
  return (result ^ (result >>> 16)) >>> 0;
}

function rgb(hue, saturation, lightness) {
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  return [0, 8, 4].map(offset => {
    const phase = (offset + hue / 30) % 12;
    return Math.round(255 * (lightness - amplitude * Math.max(-1, Math.min(phase - 3, 9 - phase, 1))));
  }).join(', ');
}

function customColor(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return null;
  const channels = [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
  const [r, g, b] = channels.map(channel => channel / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const light = (max + min) / 2;
  let hue = 0;
  if (delta) hue = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
  return {hue, saturation: delta ? delta / (1 - Math.abs(2 * light - 1)) : 0, tint: channels.join(', '), accent: value.toLowerCase()};
}

function foreground(tint) {
  const luminance = tint.split(', ').map(Number).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}

/**
 * @returns {Map<string, {hue: number, tint: string, color: string, accent: string, foreground: string}>}
 * Pass all accessible rooms, including archived ancestors. Merge branches follow
 * their primary parent; missing parents start a new family. tint is an RGB tuple
 * for translucent surfaces, while color is dark enough for text on light glass.
 * A saved room.color overrides that room and anchors its automatic descendants.
 * accent preserves the selected color; foreground is readable on that accent.
 */
export function sessionColors(rooms = [], forks = []) {
  const ids = new Set((Array.isArray(rooms) ? rooms : [])
    .filter(room => room && typeof room.id === 'string' && room.id.length)
    .map(room => room.id));
  const candidates = new Map([...ids].map(id => [id, new Map()]));
  for (const link of Array.isArray(forks) ? forks : []) {
    if (!link || !ids.has(link.id)) continue;
    const ordered = [link.parent, ...(Array.isArray(link.parents) ? link.parents : []), link.mergedFrom];
    ordered.forEach((parent, rank) => {
      if (parent === link.id || !ids.has(parent)) return;
      const choices = candidates.get(link.id);
      choices.set(parent, Math.min(choices.get(parent) ?? Infinity, rank));
    });
  }
  // Tie-breaking also makes malformed duplicate links independent of input order.
  const parents = new Map([...candidates].map(([id, choices]) => [id,
    [...choices].sort(([a, rankA], [b, rankB]) => rankA - rankB || (a < b ? -1 : a > b ? 1 : 0))[0]?.[0],
  ]));
  const roots = new Map();
  for (const id of ids) {
    if (roots.has(id)) continue;
    const path = [], positions = new Map();
    let current = id, root;
    while (!roots.has(current)) {
      if (positions.has(current)) {
        // Cycles cannot recurse forever or acquire a different family on reorder.
        root = path.slice(positions.get(current)).sort()[0];
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      const parent = parents.get(current);
      if (!parent) { root = current; break; }
      current = parent;
    }
    root ??= roots.get(current);
    for (const member of path) roots.set(member, root);
  }
  const overrides = new Map((Array.isArray(rooms) ? rooms : []).filter(room => room && ids.has(room.id)).map(room => [room.id, customColor(room.color)]));
  const colors = new Map(), offsets = new Map(), families = new Map(), children = new Map([...ids].map(id => [id, []]));
  const created = new Map((Array.isArray(rooms) ? rooms : []).filter(room => room && ids.has(room.id)).map(room => [room.id, typeof room.createdAt === 'number' ? room.createdAt : Date.parse(room.createdAt) || 0]));
  for (const id of ids) {
    const parent = parents.get(id);
    // Break the canonical cycle at its root, just as the root lookup does above.
    if (id !== roots.get(id) && parent) children.get(parent).push(id);
  }
  // Existing branches keep their choices as newer siblings are appended. Sorting
  // by creation then ID makes input ordering, search and drag placement irrelevant.
  for (const siblings of children.values()) siblings.sort((a, b) => created.get(a) - created.get(b) || a.localeCompare(b));
  const usedByParent = new Map();
  const pending = [...ids].filter(id => id === roots.get(id));
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const id = pending[cursor], root = roots.get(id), override = overrides.get(id);
    const family = override ? {hue: override.hue, saturation: override.saturation} : families.get(parents.get(id)) ?? {hue: hash('root:' + root) % 360};
    families.set(id, family);
    const base = family.hue, seed = hash('fork:' + id), parentOffset = offsets.get(parents.get(id)) ?? 0;
    const used = usedByParent.get(parents.get(id)) ?? new Set();
    const choices = [-48, -36, -24, -12, 0, 12, 24, 36, 48].filter(value => Math.abs(value - parentOffset) >= 24);
    const separation = value => Math.min(...[...used].map(previous => Math.abs(value - previous)), 96);
    const best = Math.max(...choices.map(separation));
    const available = choices.filter(value => separation(value) === best);
    const automaticVariation = id === root ? 0 : available[seed % available.length];
    const variation = override ? 0 : automaticVariation;
    // Reserve the same sibling slot when only this room is customized.
    if (id !== root) { used.add(automaticVariation); usedByParent.set(parents.get(id), used); }
    const hue = Math.round(((base + variation + 360) % 360) * 100) / 100 % 360;
    // Alternate light/dark tints as well as hue. Pale glass otherwise makes even
    // fairly different neighboring blues look almost identical.
    const light = id === root ? 0.60 : variation > 0 ? 0.50 + (seed % 5) / 100 : 0.67 + (seed % 5) / 100;
    const saturation = family.saturation ?? (id === root ? 0.65 : variation > 0 ? 0.73 : 0.56);
    const textSaturation = id === root ? 54 : variation > 0 ? 64 : 48;
    const textLightness = id === root ? 27 : variation > 0 ? 24 : 28;
    const tint = override?.tint ?? rgb(hue, saturation, light);
    const color = family.saturation !== undefined ? `hsl(${hue} ${Math.round(Math.min(saturation * 100, 64))}% 24%)` : `hsl(${hue} ${textSaturation}% ${textLightness}%)`;
    colors.set(id, {hue, tint, color, accent: override?.accent ?? `rgb(${tint})`, foreground: foreground(tint)});
    offsets.set(id, variation);
    pending.push(...children.get(id));
  }
  return new Map([...ids].map(id => [id, colors.get(id)]));
}
