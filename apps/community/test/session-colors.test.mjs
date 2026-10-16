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
  for (const {hue} of colors.values()) assert.ok(distance(hue, rootHue) <= 48);
  for (const link of forks) assert.ok(distance(colors.get(link.id).hue, colors.get(link.parent).hue) >= 24, 'each fork is visibly different from its immediate parent');
  assert.ok(new Set([...colors.values()].map(value => value.hue)).size >= 7);
});

test('merges follow their primary parent and archived ancestors retain the family', () => {
  const rooms = [room('alpha'), room('beta'), room('fork'), room('merge')];
  const forks = [{id: 'fork', parent: 'alpha'}, {id: 'merge', parent: 'fork', parents: ['fork', 'beta'], mergedFrom: 'beta', operation: 'merge'}];
  const colors = sessionColors(rooms, forks);
  const withoutSecondary = sessionColors(rooms, [{id: 'fork', parent: 'alpha'}, {id: 'merge', parent: 'fork'}]);
  assert.deepEqual(colors.get('merge'), withoutSecondary.get('merge'));
  assert.ok(distance(colors.get('merge').hue, colors.get('alpha').hue) <= 48);
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
  assert.ok(distance(fallback.get('child').hue, fallback.get('visible').hue) <= 48);
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
  for (const id of ['b', 'c']) assert.ok(distance(colors.get(id).hue, colors.get('a').hue) <= 48);
  assert.deepEqual(colors.get('outside'), sessionColors([room('outside')]).get('outside'));
});

test('text colors have at least 5:1 contrast on a pale glass background across all hues', () => {
  const luminance = channels => channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const background = luminance([244 / 255, 242 / 255, 250 / 255]);
  const colors = sessionColors(Array.from({length: 4096}, (_, index) => room('contrast-' + index)));
  const byHue = new Map([...colors.values()].map(value => [value.hue, value.color]));
  assert.equal(byHue.size, 360, 'exercise every hue generated by the helper');
  const forkRooms = Array.from({length: 720}, (_, index) => room('contrast-fork-' + index));
  const forkColors = sessionColors([...Array.from({length: 360}, (_, index) => room('contrast-' + index)), ...forkRooms], forkRooms.map((value, index) => ({id: value.id, parent: 'contrast-' + (index % 360)})));
  for (const color of [...byHue.values(), ...[...forkColors.values()].map(value => value.color)]) {
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


test('sibling forks have distinct hues and new later forks do not recolor earlier branches', () => {
  const rooms = ['root', 'a', 'b', 'c', 'd'].map((id, index) => ({...room(id), createdAt: index + 1}));
  const forks = rooms.slice(1).map(value => ({id: value.id, parent: 'root'}));
  const initial = sessionColors(rooms, forks), hues = forks.map(link => initial.get(link.id).hue);
  assert.equal(new Set(hues).size, 4);
  for (let i = 0; i < hues.length; i += 1) for (let j = i + 1; j < hues.length; j += 1) assert.ok(distance(hues[i], hues[j]) >= 12);
  const updated = sessionColors([{...room('earlier-alphabetic-id'), createdAt: 99}, ...rooms], [{id: 'earlier-alphabetic-id', parent: 'root'}, ...forks]);
  for (const id of initial.keys()) assert.deepEqual(updated.get(id), initial.get(id));
});

test('saved colors preserve exact accents with legible text and reset to the automatic palette', () => {
  const automatic=sessionColors([room('chosen')]).get('chosen');
  const selected=sessionColors([{...room('chosen'),color:'#aBcDeF'}]).get('chosen');
  assert.equal(selected.accent,'#abcdef');assert.equal(selected.tint,'171, 205, 239');assert.equal(selected.hue,210);
  assert.equal(selected.foreground,'#000000');assert.notEqual(selected.color,selected.accent,'pale accents still have a dark text variant');
  for(const color of [null,undefined,'red','#abc','#12345678','var(--bad)',{}])assert.deepEqual(sessionColors([{...room('chosen'),color}]).get('chosen'),automatic);
  assert.equal(sessionColors([{...room('chosen'),color:'#000000'}]).get('chosen').foreground,'#ffffff');
  assert.equal(sessionColors([{...room('chosen'),color:'#ffffff'}]).get('chosen').foreground,'#000000');
});

test('custom colors anchor related fork families without recoloring siblings or unrelated roots', () => {
  const rooms=['root','a','b','c','aa','aaa','unrelated'].map((id,index)=>({...room(id),createdAt:index}));
  const forks=[{id:'a',parent:'root'},{id:'b',parent:'root'},{id:'c',parent:'root'},{id:'aa',parent:'a'},{id:'aaa',parent:'aa'}];
  const before=sessionColors(rooms,forks);
  const customRooms=rooms.map(value=>({...value,...(value.id==='a'?{color:'#00cc66'}:{})}));
  const after=sessionColors(customRooms,forks);
  assert.deepEqual(sessionColors([...customRooms].reverse(),[...forks].reverse()),after);
  assert.equal(after.get('a').accent,'#00cc66');assert.equal(after.get('a').hue,150);
  for(const id of ['root','b','c','unrelated'])assert.deepEqual(after.get(id),before.get(id));
  for(const id of ['aa','aaa'])assert.ok(distance(after.get(id).hue,150)<=48);
  assert.ok(distance(after.get('aa').hue,after.get('a').hue)>=24);
  const gray=sessionColors(rooms.map(value=>({...value,...(value.id==='root'?{color:'#808080'}:{})})),forks);
  for(const id of ['a','aa','aaa'])assert.equal(new Set(gray.get(id).tint.split(', ')).size,1,'neutral parent colors keep neutral descendants');
});

test('custom and automatic button foregrounds meet 4.5:1 contrast across the RGB cube', () => {
  const luminance=channels=>channels.map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
  const rooms=[];
  for(let r=0;r<=255;r+=17)for(let g=0;g<=255;g+=17)for(let b=0;b<=255;b+=17)rooms.push({id:`rgb-${r}-${g}-${b}`,color:'#'+[r,g,b].map(value=>value.toString(16).padStart(2,'0')).join('')});
  for(const {tint,foreground} of [...sessionColors(rooms).values(),...sessionColors(rooms.map(({id})=>({id}))).values()]) {
    const background=luminance(tint.split(', ').map(value=>Number(value)/255));
    const contrast=foreground==='#ffffff'?1.05/(background+0.05):(background+0.05)/0.05;
    assert.ok(contrast>=4.5,`${tint} with ${foreground}`);
  }
});
