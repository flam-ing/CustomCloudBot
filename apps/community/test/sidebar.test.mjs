import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSidebarStore} from '../sidebar.mjs';

function initialize(db){
  db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS room_members(room_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(room_id,user_id));');
  return createSidebarStore(db);
}
function joinRooms(db,userId,rooms){
  const insert=db.prepare('INSERT INTO room_members VALUES(?,?)');
  for(const room of rooms)insert.run(room,userId);
}
const settings=(roomOrder)=>({width:280,groups:[],roomOrder});

test('manual session order survives restart and remains separate for each user',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'community-sidebar-'));
  const path=join(dir,'sidebar.sqlite');
  let db=new DatabaseSync(path),store=initialize(db);
  t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
  const first=randomUUID(),second=randomUUID(),privateRoom=randomUUID();
  joinRooms(db,'alice',[first,second,privateRoom]);
  joinRooms(db,'bob',[first,second]);
  store.write('alice',settings([second,privateRoom,first]));
  store.write('bob',settings([first,second]));
  db.close();db=new DatabaseSync(path);store=initialize(db);
  assert.deepEqual(store.read('alice').roomOrder,[second,privateRoom,first]);
  assert.deepEqual(store.read('bob').roomOrder,[first,second]);
  assert.deepEqual(store.read('new-user'),{width:280,groups:[],roomOrder:[]});
});

test('legacy sidebar preferences gain an empty order and width/group updates preserve saved order',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const store=initialize(db),room=randomUUID(),group=randomUUID();
    joinRooms(db,'alice',[room]);
    db.prepare('INSERT INTO settings VALUES(?,?)').run('sidebar:alice',JSON.stringify({width:320,groups:[{id:group,name:'작업',collapsed:true}]}));
    assert.deepEqual(store.read('alice'),{width:320,groups:[{id:group,name:'작업',collapsed:true}],roomOrder:[]});
    store.write('alice',{...store.read('alice'),roomOrder:[room]});
    const legacyWrite=store.write('alice',{width:350,groups:[]});
    assert.deepEqual(legacyWrite,{width:350,groups:[],roomOrder:[room]});
    assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('sidebar:alice').value).roomOrder,[room]);
    assert.deepEqual(store.write('alice',{width:350,groups:[],roomOrder:[]}).roomOrder,[]);
  }finally{db.close();}
});

test('invalid, duplicate, oversized, and inaccessible orders leave existing preferences unchanged',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const store=initialize(db),room=randomUUID(),otherRoom=randomUUID();
    joinRooms(db,'alice',[room]);joinRooms(db,'bob',[otherRoom]);
    const before=store.write('alice',settings([room]));
    for(const roomOrder of [null,'invalid',[room,room],['not-a-uuid'],[null],[otherRoom],[randomUUID()],Array.from({length:1001},()=>randomUUID())]){
      assert.throws(()=>store.write('alice',{width:400,groups:[],roomOrder}),error=>error.status===400);
      assert.deepEqual(store.read('alice'),before);
    }
  }finally{db.close();}
});

test('revoked memberships are removed from reads and do not survive a legacy preference update',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const store=initialize(db),first=randomUUID(),second=randomUUID();
    joinRooms(db,'alice',[first,second]);
    store.write('alice',settings([second,first]));
    db.prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').run(second,'alice');
    assert.deepEqual(store.read('alice').roomOrder,[first]);
    store.write('alice',{width:300,groups:[]});
    const stored=JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('sidebar:alice').value);
    assert.deepEqual(stored.roomOrder,[first]);
    assert.throws(()=>store.write('alice',settings([second,first])),error=>error.status===400);
  }finally{db.close();}
});
