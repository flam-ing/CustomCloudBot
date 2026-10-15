import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutBranches, relatedBranchIds} from '../public/branch-graph.mjs';
const rooms = ['root','a','b','deep','merge','other'].map((id, i) => ({id, name:id, createdAt:i+1}));
const links = [{id:'a',parent:'root'},{id:'b',parent:'root'},{id:'deep',parent:'a'},{id:'merge',parent:'deep',mergedFrom:'b'}];
test('parents precede children and a merge retains both real parents and colored lanes', () => {
  const result=layoutBranches(rooms,links), byId=new Map(result.rows.map(row=>[row.id,row]));
  assert.equal(result.edges.length,5); assert(result.laneCount>1);
  for(const edge of result.edges)assert(byId.get(edge.from).index<byId.get(edge.to).index);
  assert.deepEqual(byId.get('merge').parents,['deep','b']);assert.equal(result.edges.filter(edge=>edge.secondary).length,1);
  assert.equal(byId.get('other').operation,'root');
});
test('search preserves ancestors of both merge parents and marks only actual matches', () => {
  const result=layoutBranches(rooms,links,{query:'MERGE'});
  assert.deepEqual(new Set(result.rows.map(row=>row.id)),new Set(['root','a','b','deep','merge']));
  assert.deepEqual(result.rows.filter(row=>row.matched).map(row=>row.id),['merge']);
  assert.equal(layoutBranches(rooms,links,{query:'unmatched'}).rows.length,0);
});
test('archived and inaccessible parents never create ghost nodes or invented lineage', () => {
  const result=layoutBranches([{id:'a',name:'a',archived:true},{id:'b',name:'b'},{id:'c',name:'c'}],[{id:'b',parent:'a'},{id:'c',parent:'secret',parents:['b']}]);
  assert.deepEqual(result.rows.map(row=>row.id),['b','c']);assert.deepEqual(result.edges,[{from:'b',to:'c',secondary:false}]);
});
test('cycles and duplicate or self links are bounded and deterministic', () => {
  const r=[{id:'a'},{id:'b'},{id:'c'}], l=[{id:'a',parent:'b'},{id:'b',parent:'a',parents:['a','b']},{id:'c',parent:'b',mergedFrom:'b'}];
  const result=layoutBranches(r,l);assert.equal(result.rows.length,3);assert.equal(result.edges.length,2);assert.deepEqual(layoutBranches(r,l),result);
  assert.deepEqual(new Set(relatedBranchIds('a',r,l)),new Set(['b','c']));
});
test('deep related candidates traverse merge parents and archived ancestors, using IDs not names', () => {
  const r=rooms.map(room=>({...room,name:'same',archived:room.id==='root'}));
  assert.deepEqual(new Set(relatedBranchIds('deep',r,links)),new Set(['a','b','merge']));
  assert.deepEqual(relatedBranchIds('missing',r,links),[]);
  assert.deepEqual(relatedBranchIds('other',r,links),[]);
});
test('a merge keeps its operation label with one accessible parent, but no-parent nodes are roots', () => {
  const result=layoutBranches([{id:'a'},{id:'b'},{id:'c'}],[{id:'b',parent:null,mergedFrom:'a',parents:['a'],operation:'merge'},{id:'c',parent:null,parents:[],operation:'fork'}]);
  assert.equal(result.rows.find(row=>row.id==='b').operation,'merge');assert.equal(result.rows.find(row=>row.id==='c').operation,'root');
  assert.equal(result.edges.length,1);
});
test('manual placement allows children above parents without changing lineage, merge labels or lanes', () => {
  const baseline=layoutBranches(rooms,links), order=['merge','deep','b','a','root','other'];
  const result=layoutBranches(rooms,links,{order}), byId=new Map(result.rows.map(row=>[row.id,row]));
  assert.deepEqual(result.rows.map(row=>row.id),order);
  assert.deepEqual(result.rows.map(row=>row.index),[0,1,2,3,4,5]);
  assert.deepEqual(result.edges,baseline.edges);
  assert.equal(result.laneCount,baseline.laneCount);
  for(const row of baseline.rows)assert.deepEqual(byId.get(row.id),{...row,index:order.indexOf(row.id)});
  assert(byId.get('merge').index<byId.get('deep').index);
  assert.deepEqual(byId.get('merge').parents,['deep','b']);
  assert.equal(byId.get('merge').operation,'merge');
  assert.deepEqual(layoutBranches(rooms,links),baseline);
});
test('partial manual order ignores duplicates and missing IDs and appends unlisted rows in default order', () => {
  const updated=[...rooms,{id:'new',name:'new',createdAt:20}], baseline=layoutBranches(updated,links);
  const order=['deep','missing','deep','a'], result=layoutBranches(updated,links,{order});
  assert.deepEqual(result.rows.map(row=>row.id),['deep','a',...baseline.rows.filter(row=>!['deep','a'].includes(row.id)).map(row=>row.id)]);
  assert.deepEqual(result.rows.map(row=>row.index),result.rows.map((_,index)=>index));
  assert.deepEqual(result.edges,baseline.edges);
  assert.deepEqual(layoutBranches(updated,links,{order}),result);
  assert.deepEqual(order,['deep','missing','deep','a']);
  assert.deepEqual(layoutBranches(updated,links,{order:null}),baseline);
});
test('manual order preserves search ancestors even when they follow the matching child', () => {
  const result=layoutBranches(rooms,links,{query:'merge',order:['other','merge','deep','b','a','root']});
  assert.deepEqual(result.rows.map(row=>row.id),['merge','deep','b','a','root']);
  assert.deepEqual(result.rows.filter(row=>row.matched).map(row=>row.id),['merge']);
  assert.deepEqual(result.edges,layoutBranches(rooms,links,{query:'merge'}).edges);
});
