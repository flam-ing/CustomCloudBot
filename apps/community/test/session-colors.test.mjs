import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionColors} from '../public/session-colors.js';

const room = id => ({id, name: id});
const distance = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

test('session colors survive refresh, pane order, renaming and unrelated room changes', () => {
  const rooms = ['root', 'child', 'other'].map(room), forks = [{id: 'child', parent: 'root'}];
  const initial = sessionColors(rooms, forks);
  assert.deepEqual(sessionColors(rooms, forks), initial);
  assert.deepEqual(sessionColors([...rooms].reverse().map(value => ({...value, name: 'renamed', pinned: true})), [...forks].reverse()), initial);
  const extended = sessionColors([room('new unrelated room'), ...rooms], forks);
  for (const id of initial.keys()) assert.deepEqual(extended.get(id), initial.get(id));
  assert.deepEqual(sessionColors([room('other')]).get('other'), initial.get('other'));
});

test('many independent roots span the color wheel rather than repeating three pane colors', () => {
  const rooms = Array.from({length: 128}, (_, index) => room(`00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`));
  const colors = [...sessionColors(rooms).values()];
  assert.ok(new Set(colors.map(value => value.hue)).size > 80);
  assert.ok(new Set(colors.map(value => Math.floor(value.hue / 30))).size >= 11);
  for (const {hue, tint, color} of colors) {
    assert.ok(hue >= 0 && hue < 360);
    assert.match(tint, /^\d{1,3}, \d{1,3}, \d{1,3}$/);
    assert.ok(tint.split(', ').every(channel => Number(channel) >= 0 && Number(channel) <= 255));
    assert.match(color, /^hsl\(\d+ 54% 27%\)$/);
  }
});

test('deep forks keep a bounded root family without hue drift or recursive stack growth', () => {
  const rooms = [room('root')], forks = [];
  for (let index = 0; index < 10000; index += 1) {
    rooms.push(room(`branch-${index}`));
    forks.push({id: `branch-${index}`, parent: index ? `branch-${index - 1}` : 'root'});
  }
  // Children first forces ancestry traversal rather than relying on server order.
  const colors = sessionColors(rooms.reverse(), forks.reverse()), rootHue = colors.get('root').hue;
  for (const {hue} of colors.values()) assert.ok(distance(hue, rootHue) <= 14);
  assert.ok(new Set([...colors.values()].map(value => value.hue)).size > 10);
});

test('merges follow their primary parent and archived ancestors retain the family', () => {
  const rooms = [room('alpha'), room('beta'), room('fork'), room('merge')];
  const forks = [{id: 'fork', parent: 'alpha'}, {id: 'merge', parent: 'fork', parents: ['fork', 'beta'], mergedFrom: 'beta', operation: 'merge'}];
  const colors = sessionColors(rooms, forks);
  const withoutSecondary = sessionColors(rooms, [{id: 'fork', parent: 'alpha'}, {id: 'merge', parent: 'fork'}]);
  assert.deepEqual(colors.get('merge'), withoutSecondary.get('merge'));
  assert.ok(distance(colors.get('merge').hue, colors.get('alpha').hue) <= 14);
  assert.deepEqual(sessionColors(rooms.map(value => ({...value, archived: value.id === 'alpha'})), forks), colors);
});

test('missing parents, invalid inputs and self links never create ghost sessions', () => {
  const colors = sessionColors([null, {}, room('child'), room('visible')], [{id: 'child', parent: 'hidden'}, {id: 'visible', parent: 'visible'}, {id: 'unknown', parent: 'visible'}]);
  assert.deepEqual([...colors.keys()], ['child', 'visible']);
  assert.deepEqual(colors.get('child'), sessionColors([room('child')]).get('child'));
  assert.deepEqual(colors.get('visible'), sessionColors([room('visible')]).get('visible'));
  assert.deepEqual(sessionColors(null, null), new Map());
  assert.deepEqual(sessionColors([room('child')], null), sessionColors([room('child')]));
  const fallback = sessionColors([room('child'), room('visible')], [{id: 'child', parent: 'hidden', parents: ['hidden', 'visible']}]);
  assert.ok(distance(fallback.get('child').hue, fallback.get('visible').hue) <= 14);
});

test('cycles and duplicate links resolve deterministically without modifying inputs', () => {
  const rooms = Object.freeze(['a', 'b', 'c', 'outside'].map(id => Object.freeze(room(id))));
  const forks = Object.freeze([
    Object.freeze({id: 'a', parent: 'b'}), Object.freeze({id: 'b', parent: 'a'}),
    Object.freeze({id: 'c', parent: 'b', parents: Object.freeze(['b', 'b'])}),
    Object.freeze({id: 'c', parent: 'a'}),
  ]);
  const colors = sessionColors(rooms, forks);
  assert.deepEqual(sessionColors([...rooms].reverse(), [...forks].reverse()), colors);
  assert.deepEqual(colors.get('a'), sessionColors([room('a')]).get('a'));
  for (const id of ['b', 'c']) assert.ok(distance(colors.get(id).hue, colors.get('a').hue) <= 14);
  assert.deepEqual(colors.get('outside'), sessionColors([room('outside')]).get('outside'));
});

test('text colors have at least 5:1 contrast on a pale glass background across all hues', () => {
  const luminance = channels => channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const background = luminance([244 / 255, 242 / 255, 250 / 255]);
  const colors = sessionColors(Array.from({length: 4096}, (_, index) => room('contrast-' + index)));
  const byHue = new Map([...colors.values()].map(value => [value.hue, value.color]));
  assert.equal(byHue.size, 360, 'exercise every hue generated by the helper');
  for (const color of byHue.values()) {
    const [, hueText, saturationText, lightnessText] = color.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/);
    const hue = Number(hueText), saturation = Number(saturationText) / 100, lightness = Number(lightnessText) / 100;
    // Independently convert the returned CSS color to verify real text contrast.
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const intermediate = chroma * (1 - Math.abs((hue / 60) % 2 - 1)), offset = lightness - chroma / 2;
    const sectors = [[chroma, intermediate, 0], [intermediate, chroma, 0], [0, chroma, intermediate], [0, intermediate, chroma], [intermediate, 0, chroma], [chroma, 0, intermediate]];
    const foreground = luminance(sectors[Math.floor(hue / 60)].map(value => value + offset));
    assert.ok((background + 0.05) / (foreground + 0.05) >= 5, `hue ${hue} must remain legible`);
  }
});
