import test from 'node:test';
import assert from 'node:assert/strict';
import {renderTranscript,disposeTranscript} from '../public/transcript.mjs';

class Element {
  constructor({height=100,list=false}={}) {
    this.height=height;this.isList=list;this.children=[];this.parentNode=null;
    this.handlers=new Map();this.moves=0;this.detaches=0;this._scrollTop=0;
    this.clientHeight=list?200:height;this.isConnected=true;
  }
  get scrollHeight(){return this.children.reduce((sum,node)=>sum+node.height,0);}
  get scrollTop(){return this._scrollTop;}
  set scrollTop(value){this._scrollTop=Math.max(0,Math.min(value,Math.max(0,this.scrollHeight-this.clientHeight)));}
  get firstElementChild(){return this.children[0]||null;}
  get nextElementSibling(){return this.parentNode?.children[this.parentNode.children.indexOf(this)+1]||null;}
  insertBefore(node,before){
    if(node.parentNode)node.remove();
    const index=before?this.children.indexOf(before):this.children.length;
    assert.notEqual(index,-1);
    this.children.splice(index,0,node);node.parentNode=this;node.isConnected=true;node.moves++;
  }
  remove(){if(this.parentNode){this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);this.parentNode=null;this.isConnected=false;this.detaches++;}}
  getBoundingClientRect(){
    const top=this.parentNode?this.parentNode.children.slice(0,this.parentNode.children.indexOf(this)).reduce((sum,node)=>sum+node.height,0)-this.parentNode.scrollTop:0;
    return {top,bottom:top+(this.isList?this.clientHeight:this.height)};
  }
  addEventListener(type,handler){this.handlers.set(type,handler);}
  removeEventListener(type,handler){if(this.handlers.get(type)===handler)this.handlers.delete(type);}
  fire(type){this.handlers.get(type)?.();}
}
class Observer {
  static instances=[];
  constructor(callback){this.callback=callback;this.targets=new Set();this.disconnected=false;Observer.instances.push(this);}
  observe(node){this.targets.add(node);}
  unobserve(node){this.targets.delete(node);}
  disconnect(){this.targets.clear();this.disconnected=true;}
  fire(){this.callback();}
}
const message=(id,extra={})=>({id,kind:'human',authorId:'owner',author:'Name',text:id,createdAt:1234,...extra});
function setup(roomId='one') {
  const list=new Element({list:true}),created=[],updated=[];
  const options={roomId,ResizeObserver:Observer,
    createMessage:(value,{animate})=>{const node=new Element({height:value.height||100});node.id=value.id;node.animate=animate;created.push(node);return node;},
    updateMessage:(node,value)=>updated.push([node,value]),
    createThinking:()=>{const node=new Element({height:40});node.id='thinking';return node;},
    empty:()=>{const node=new Element({height:30});node.id='empty';return node;},
  };
  return {list,options,created,updated,render:(messages,extra={})=>renderTranscript(list,messages,{...options,...extra})};
}

test('unchanged messages stay attached with selection and playback state in main and split lists',()=>{
  for(const room of ['main','split']){
    const s=setup(room),messages=[message('a'),message('b'),message('c')];s.render(messages);
    const nodes=[...s.list.children];nodes[1].selection='selected text';nodes[1].playback=42;
    s.render(structuredClone(messages),{busy:true});s.render(structuredClone(messages),{busy:false});
    assert.deepEqual(s.list.children,nodes);
    assert.equal(nodes[1].selection,'selected text');assert.equal(nodes[1].playback,42);
    assert.ok(nodes.every(node=>node.moves===1&&node.detaches===0));
    assert.equal(s.updated.length,6);disposeTranscript(s.list);
  }
});

test('changed author identity, content, attachment name and pending state replace only their own bubble',()=>{
  const s=setup();let values=[message('a'),message('b',{attachments:[{id:'photo',kind:'image',name:'before.png',url:'/photo',width:100,height:90}]}),message('c')];s.render(values);
  const stable=s.list.children[0];let replaced=s.list.children[1];
  for(const patch of [{authorId:'another'},{text:'changed'},{attachments:[{id:'photo',kind:'image',name:'after.png',url:'/photo',width:100,height:90}]},{pending:'failed',error:'offline'}]){
    values=values.map((value,index)=>index===1?{...value,...patch}:value);s.render(values);
    assert.equal(s.list.children[0],stable);assert.notEqual(s.list.children[1],replaced);
    assert.equal(s.list.children[1].animate,false);replaced=s.list.children[1];
  }
  assert.equal(stable.detaches,0);disposeTranscript(s.list);
});

test('pending acknowledgement with server id and nonce does not replay entry animation',()=>{
  const s=setup();s.render([message('old')]);
  const pending=message('pending:nonce',{pending:'sending',clientNonceHash:'hash'});
  s.render([message('old'),pending],{forceBottom:true});assert.equal(s.list.children[1].animate,true);
  s.render([message('old'),message('server-id',{clientNonceHash:'hash'})]);assert.equal(s.list.children[1].animate,false);
  // POST can mutate the optimistic object id before the next GET reconciles it.
  const second=message('pending:other',{pending:'sending'});s.render([message('old'),second]);second.id='server-other';
  s.render([message('old'),message('server-other')]);assert.equal(s.list.children[1].animate,false);
  disposeTranscript(s.list);
});

test('polling preserves a reading anchor while initial paint and explicit own send follow bottom',()=>{
  const s=setup(),values=Array.from({length:10},(_,i)=>message(String(i)));s.render(values);
  assert.equal(s.list.scrollTop,800);s.list.scrollTop=300;s.list.fire('scroll');
  const anchor=s.list.children[3],before=anchor.getBoundingClientRect().top;
  s.render([{...values[0],text:'grew',height:200},...values.slice(1),message('new')]);
  assert.equal(s.list.scrollTop,400);assert.equal(anchor.getBoundingClientRect().top,before);
  s.render([...values,message('own')],{forceBottom:true});assert.equal(s.list.scrollTop,900);
  disposeTranscript(s.list);
});

test('late image resizing follows bottom only while pinned and releases removed nodes',()=>{
  const s=setup(),values=[message('a'),message('b'),message('c')];s.render(values);
  const observer=Observer.instances.at(-1),removed=s.list.children[0];
  s.list.children[1].height+=80;observer.fire();assert.equal(s.list.scrollTop,180);
  s.list.scrollTop=0;s.list.fire('scroll');s.list.children[1].height+=70;observer.fire();assert.equal(s.list.scrollTop,0);
  s.render(values.slice(1));assert.equal(observer.targets.has(removed),false);
  disposeTranscript(s.list);assert.equal(observer.disconnected,true);assert.equal(observer.targets.size,0);assert.equal(s.list.handlers.size,0);
});

test('new rooms and externally cleared lists render fresh without retaining their former nodes',()=>{
  const s=setup();s.render([message('same'),message('b'),message('c')]);const previous=[...s.list.children];
  s.render([message('same',{text:'other room'})],{roomId:'other'});assert.notEqual(s.list.children[0],previous[0]);assert.equal(s.list.children[0].animate,false);
  const observer=Observer.instances.at(-1);assert.ok(previous.every(node=>!observer.targets.has(node)));
  const old=s.list.children[0];old.remove();s.render([message('same',{text:'other room'})],{roomId:'other'});
  assert.notEqual(s.list.children[0],old);assert.equal(s.list.children[0].animate,false);assert.equal(observer.targets.has(old),false);
  disposeTranscript(s.list);
});

test('observer notices a detached list and disconnects even before an explicit cleanup',()=>{
  const s=setup();s.render([message('a')]);const observer=Observer.instances.at(-1);s.list.isConnected=false;observer.fire();
  assert.equal(observer.disconnected,true);assert.equal(s.list.handlers.size,0);
  disposeTranscript(s.list);
});
