import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceWindows,workspaceBounds} from '../public/workspace-windows.js';

function setup(maxOpen=6){
  const records=new Map(),changes=[];let limited=0;
  const manager=createWorkspaceWindows({maxOpen,onLimit:()=>limited++,onChange:value=>changes.push(value),createWindow:(roomId,{onClose})=>{
    const record={opens:0,closes:0,destroys:0,onClose};records.set(roomId,record);
    return {open:()=>record.opens++,close:()=>record.closes++,destroy:()=>record.destroys++};
  }});
  return {manager,records,changes,get limited(){return limited;}};
}

test('navigating rooms never auto-opens, retargets, or closes existing popups',()=>{
  const {manager,records,changes}=setup();
  manager.setRoom('first');assert.equal(records.size,0);
  manager.openRoom();manager.setRoom('second');assert.equal(records.size,1);assert.equal(records.get('first').closes,0);
  manager.openRoom();assert.equal(records.size,2);assert.deepEqual(changes.at(-1),{roomId:'second',open:true});
  manager.setRoom('first');manager.toggle();assert.equal(records.get('first').closes,1);assert.equal(records.get('second').closes,0);
  manager.openRoom();assert.equal(records.get('first').opens,2);assert.equal(records.size,2);
});

test('close callbacks only close their own room and reopen the same instance',()=>{
  const {manager,records,changes}=setup();manager.setRoom('first');manager.openRoom();manager.openRoom('second');
  records.get('second').onClose();assert.equal(records.get('second').closes,1);assert.equal(records.get('first').closes,0);
  assert.deepEqual(changes.at(-1),{roomId:'first',open:true});
  manager.openRoom('second');assert.equal(records.get('second').opens,2);assert.equal(records.size,2);
});

test('open limit preserves other windows and permits reopening after a close',()=>{
  const fixture=setup(2),{manager,records}=fixture;
  assert.equal(manager.openRoom('a'),true);assert.equal(manager.openRoom('b'),true);assert.equal(manager.openRoom('c'),false);
  assert.equal(fixture.limited,1);assert.equal(records.size,2);assert.equal(manager.openRoom('a'),true);
  manager.closeRoom('b');assert.equal(manager.openRoom('c'),true);assert.equal(records.get('a').closes,0);
});

test('account reset destroys open and closed views and prevents stale room reuse',()=>{
  const {manager,records,changes}=setup();manager.setRoom('private');manager.openRoom();manager.openRoom('closed');manager.closeRoom('closed');
  const privateWindow=records.get('private'),closedWindow=records.get('closed');manager.reset();
  assert.equal(privateWindow.destroys,1);assert.equal(closedWindow.destroys,1);assert.deepEqual(changes.at(-1),{roomId:null,open:false});
  assert.equal(manager.openRoom(),false);manager.setRoom('private');manager.openRoom();assert.notEqual(records.get('private'),privateWindow);
  manager.destroy();const last=records.get('private');assert.equal(last.destroys,1);manager.destroy();manager.setRoom('new');assert.equal(manager.openRoom('new'),false);assert.equal(last.destroys,1);
});

test('old closed window caches are discarded without touching open connections',()=>{
  const {manager,records}=setup();manager.openRoom('keep');
  for(let i=0;i<25;i++){manager.openRoom('room-'+i);manager.closeRoom('room-'+i);}
  assert.equal(records.get('keep').destroys,0);assert.equal(records.get('room-0').destroys,1);
});

test('geometry remains reachable when moving/resizing outside a smaller viewport',()=>{
  assert.deepEqual(workspaceBounds({left:-50,top:700,width:1200,height:900},{width:400,height:600}),{left:8,top:8,width:384,height:584});
  const small=workspaceBounds({left:1000,top:1000,width:1,height:1},{width:320,height:480});
  assert.deepEqual(small,{left:8,top:192,width:304,height:280});
  const normal=workspaceBounds({left:150,top:90,width:700,height:500},{width:1200,height:800});
  assert.deepEqual(normal,{left:150,top:90,width:700,height:500});
});
