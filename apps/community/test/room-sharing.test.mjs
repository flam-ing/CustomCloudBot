import test from "node:test";
import assert from "node:assert/strict";
import {createRoomSharing} from "../public/room-sharing.js";

class Element {
  constructor(doc,tag){this.doc=doc;this.tagName=tag;this.children=[];this.handlers={};this.attrs={};this.textContent="";this.isConnected=true;}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(key,value){this.attrs[key]=value;}
  addEventListener(event,handler){this.handlers[event]=handler;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  focus(){this.doc.activeElement=this;}
  remove(){this.isConnected=false;}
}
function fixture(t,options={}){
  const previous=globalThis.document;
  const doc={createElement:tag=>new Element(doc,tag),createElementNS:(_ns,tag)=>new Element(doc,tag)};doc.body=doc.createElement("body");globalThis.document=doc;
  let session={user:{id:"owner"}};const calls=[],invited=[],created=[];
  const ui=createRoomSharing({getSession:()=>session,api:async(...args)=>{calls.push(args);return options.api?.(...args);},onInvite:room=>invited.push(room),onRoomCreated:room=>created.push(room)});
  t.after(()=>{ui.destroy();globalThis.document=previous;});
  return {ui,doc,calls,invited,created,setSession:value=>session=value};
}
function find(node,predicate){return predicate(node)?node:node.children.map(child=>find(child,predicate)).find(Boolean);}
const withText=(doc,text)=>find(doc.body,node=>node.textContent===text);
const room={id:"12345678-1234-4234-8234-123456789012",name:"대화",role:"owner",sharing:{canInvite:true,canCreateSharedCopy:false}};

test("share opens choices first and creates an invitation only on explicit link action",async t=>{
  const f=fixture(t);f.ui.open(room);assert.equal(f.invited.length,0);assert.ok(withText(f.doc,"Markdown 다운로드"));assert.ok(withText(f.doc,"JSON 다운로드"));
  await withText(f.doc,"링크 공유").parent.parent.handlers.click();assert.deepEqual(f.invited,[room]);
});

test("personal histories require the existing explicit shared-copy confirmation",async t=>{
  const f=fixture(t,{api:async()=>({room:{id:"shared"}})});f.ui.open({...room,personal:true,sharing:{canInvite:false,canCreateSharedCopy:true}});
  await withText(f.doc,"링크 공유").parent.parent.handlers.click();
  const checkbox=find(f.doc.body,node=>node.name==="includeHistory");assert.equal(checkbox.checked,false);assert.equal(f.calls.length,0);
  const form=find(f.doc.body,node=>node.tagName==="form");await form.handlers.submit({preventDefault(){}});
  assert.deepEqual(JSON.parse(f.calls[0][1].body),{name:"대화 · 함께 대화",includeHistory:false,confirmed:true});assert.equal(f.created.length,1);assert.equal(f.invited.length,1);
});

test("an invited member can start export and closing cancels the outstanding download",async t=>{
  const pending=Promise.withResolvers(),f=fixture(t,{api:()=>pending.promise});
  f.ui.open({...room,role:"member",sharing:{canInvite:false,canCreateSharedCopy:false}});
  const downloading=withText(f.doc,"JSON 다운로드").parent.parent.handlers.click();
  assert.match(f.calls[0][0],/\/export$/);const signal=f.calls[0][1].signal;assert.equal(signal.aborted,false);
  f.ui.close();assert.equal(signal.aborted,true);
  pending.resolve({room,messages:[],through:0,next:null});await downloading;
  assert.equal(f.invited.length,0);assert.equal(f.doc.body.children[0].open,false);
});

test("a stale private-copy response cannot invite after the account changes",async t=>{
  const pending=Promise.withResolvers(),f=fixture(t,{api:()=>pending.promise});f.ui.open({...room,personal:true,sharing:{canInvite:false,canCreateSharedCopy:true}});
  await withText(f.doc,"링크 공유").parent.parent.handlers.click();
  const submitting=find(f.doc.body,node=>node.tagName==="form").handlers.submit({preventDefault(){}});
  f.setSession({user:{id:"someone-else"}});pending.resolve({room:{id:"shared"}});await submitting;
  assert.equal(f.created.length,0);assert.equal(f.invited.length,0);
});
