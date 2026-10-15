// A room's UUID supplies its random-looking seed. Pane order, titles and refreshes
// never change its color, and forks stay close to their original root's hue.
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

/**
 * @returns {Map<string, {hue: number, tint: string, color: string}>}
 * Pass all accessible rooms, including archived ancestors. Merge branches follow
 * their primary parent; missing parents start a new family. tint is an RGB tuple
 * for translucent surfaces, while color is dark enough for text on light glass.
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
  return new Map([...ids].map(id => {
    const root = roots.get(id), base = hash('root:' + root) % 360;
    const variation = id === root ? 0 : hash('fork:' + id) % 29 - 14;
    const hue = (base + variation + 360) % 360;
    return [id, {hue, tint: rgb(hue, 0.65, 0.60), color: `hsl(${hue} 54% 27%)`}];
  }));
}
