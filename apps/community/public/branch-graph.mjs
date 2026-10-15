// Layout is derived only from recorded, accessible lineage. Names never identify branches.
function graph(rooms, links) {
  const nodes = new Map(rooms.filter(room => room && typeof room.id === 'string').map(room => [room.id, room]));
  const parents = new Map([...nodes.keys()].map(id => [id, []]));
  for (const link of links || []) {
    if (!link || !nodes.has(link.id)) continue;
    const ids = [...(Array.isArray(link.parents) ? link.parents : []), link.parent, link.mergedFrom];
    parents.set(link.id, [...new Set([...parents.get(link.id), ...ids])].filter(id => id !== link.id && nodes.has(id)));
  }
  return {nodes, parents};
}
function ancestry(id, parents) {
  const found = new Set(), pending = [id];
  while (pending.length) {
    const current = pending.pop(); if (found.has(current)) continue;
    found.add(current); pending.push(...(parents.get(current) || []));
  }
  return found;
}
export function relatedBranchIds(roomId, rooms, links) {
  const {nodes, parents} = graph(rooms, links);
  if (!nodes.has(roomId)) return [];
  const mine = ancestry(roomId, parents);
  return [...nodes.values()].filter(room => room.id !== roomId && !room.archived && [...ancestry(room.id, parents)].some(id => mine.has(id))).map(room => room.id);
}
export function layoutBranches(rooms, links, {query = '', order = []} = {}) {
  const active = rooms.filter(room => !room.archived), {nodes, parents} = graph(active, links);
  const operations = new Map((links || []).filter(Boolean).map(link => [link.id, link.operation]));
  const position = new Map(active.map((room, index) => [room.id, index]));
  const time = room => typeof room.createdAt === 'number' ? room.createdAt : Date.parse(room.createdAt) || 0;
  const compare = (a, b) => time(nodes.get(a)) - time(nodes.get(b)) || position.get(a) - position.get(b) || a.localeCompare(b);
  const pending = new Set(nodes.keys()), ordered = [];
  while (pending.size) {
    let ready = [...pending].filter(id => parents.get(id).every(parent => !pending.has(parent))).sort(compare);
    if (!ready.length) {
      // A malformed cycle must not hang rendering or draw an invented connection.
      ready = [[...pending].sort(compare)[0]];
      parents.set(ready[0], parents.get(ready[0]).filter(parent => !pending.has(parent)));
    }
    const id = ready[0]; pending.delete(id); ordered.push(id);
  }
  const needle = query.trim().toLocaleLowerCase();
  const matches = new Set(ordered.filter(id => !needle || [nodes.get(id).name, nodes.get(id).description].join(' ').toLocaleLowerCase().includes(needle)));
  const visible = new Set([...matches].flatMap(id => [...ancestry(id, parents)]));
  const ids = ordered.filter(id => visible.has(id));
  const children = new Map(ids.map(id => [id, []]));
  for (const id of ids) for (const parent of parents.get(id)) if (visible.has(parent)) children.get(parent).push(id);
  const remaining = new Map(ids.map(id => [id, children.get(id).length])), occupied = new Map(), placed = new Map(), rows = [];
  for (const id of ids) {
    const prior = parents.get(id).filter(parent => placed.has(parent));
    for (const parent of prior) {
      remaining.set(parent, remaining.get(parent) - 1);
      if (!remaining.get(parent)) occupied.delete(placed.get(parent).lane);
    }
    let lane = prior.length ? placed.get(prior[0]).lane : 0;
    if (occupied.has(lane)) { lane = 0; while (occupied.has(lane)) lane += 1; }
    const row = {room: nodes.get(id), id, parents: prior, children: children.get(id), lane, index: rows.length, matched: matches.has(id), operation: prior.length ? (prior.length > 1 || operations.get(id) === 'merge' ? 'merge' : 'fork') : 'root'};
    rows.push(row); placed.set(id, row);
    if (remaining.get(id)) occupied.set(lane, id);
  }
  const edges = rows.flatMap(row => row.parents.map((parent, index) => ({from: parent, to: row.id, secondary: index > 0})));
  // User placement changes display positions, never lineage or the lanes derived
  // from it. A child can appear above its parent without losing their edge.
  const ranks = new Map();
  for (const id of Array.isArray(order) ? order : []) if (typeof id === 'string' && !ranks.has(id)) ranks.set(id, ranks.size);
  const displayed = ranks.size ? [...rows].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) || a.index - b.index).map((row, index) => ({...row, index})) : rows;
  return {rows: displayed, edges, laneCount: rows.length ? Math.max(...rows.map(row => row.lane)) + 1 : 0};
}
