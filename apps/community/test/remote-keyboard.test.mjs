import test from 'node:test';
import assert from 'node:assert/strict';
import {createRemoteKeyboard,remoteTextKeys} from '../public/remote-keyboard.js';

class Element {
  constructor(doc){this.ownerDocument=doc;this.handlers=new Map();this.attributes={};this.children=[];this.value='';}
  setAttribute(key,value){this.attributes[key]=value;}
  append(node){node.parent=this;this.children.push(node);}
  addEventListener(type,handler){if(!this.handlers.has(type))this.handlers.set(type,new Set());this.handlers.get(type).add(handler);}
  removeEventListener(type,handler){this.handlers.get(type)?.delete(handler);}
  focus(){this.ownerDocument.activeElement=this;}
  blur(){if(this.ownerDocument.activeElement===this){this.ownerDocument.activeElement=null;this.fire('blur');}}
  setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
  fire(type,details={}){const event={target:this,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...details};for(const handler of this.handlers.get(type)||[])handler(event);return event;}
}
function setup(){
  const doc={activeElement:null,createElement(){return new Element(this);}},viewport=new Element(doc),button=new Element(doc),calls=[];
  let connected=true;
  const rfb={viewOnly:false,focusOnClick:true,sendKey:(...args)=>calls.push(args)};
  const keyboard=createRemoteKeyboard({rfb,viewport,button,canInput:()=>connected});
  const input=viewport.children[0],type=value=>{input.value=value;input.fire('input');};
  return{doc,viewport,button,calls,rfb,keyboard,input,type,disconnect:()=>{connected=false;}};
}

test('keyboard button focuses a real editable synchronously, restores noVNC focus, and cleans up',()=>{
  const s=setup();assert.equal(s.input.disabled,true);assert.equal(s.doc.activeElement,null);
  s.button.fire('click');
  assert.equal(s.doc.activeElement,s.input);assert.equal(s.input.disabled,false);assert.equal(s.rfb.focusOnClick,false);
  assert.equal(s.button.attributes['aria-pressed'],'true');
  s.type('\u200bprivate text');s.button.fire('click');
  assert.equal(s.keyboard.enabled,false);assert.equal(s.doc.activeElement,null);assert.equal(s.rfb.focusOnClick,true);
  assert.equal(s.input.value,'\u200b');assert.equal(s.input.disabled,true);
  s.keyboard.destroy();assert.equal(s.viewport.children.length,0);assert.equal(s.input.value,'');
  for(const element of [s.viewport,s.button,s.input])for(const handlers of element.handlers.values())assert.equal(handlers.size,0);
});

test('Korean IME commits once and handles composition-end trailing input without duplicate text',()=>{
  const s=setup();s.button.fire('click');s.input.fire('compositionstart');
  s.input.value='\u200bㅎ';s.input.fire('input',{isComposing:true});
  s.input.value='\u200b한';s.input.fire('input',{isComposing:true});assert.deepEqual(s.calls,[]);
  s.input.fire('compositionend');s.input.fire('input');
  assert.deepEqual(s.calls,[[0x01000000|'한'.codePointAt(0),null]]);
  s.input.fire('compositionstart');s.input.value='\u200b한글';s.input.fire('compositionend');s.input.fire('input');
  assert.deepEqual(s.calls.map(call=>call[0]),remoteTextKeys('한글'));
});

test('mobile input-only backspace works at an empty field and text replacement does not delete the seed remotely',()=>{
  const s=setup();s.button.fire('click');s.type('');s.type('');
  assert.deepEqual(s.calls,[[0xff08,null],[0xff08,null]]);
  s.calls.length=0;s.type('\u200bcat');s.type('\u200bcar');s.type('');
  assert.deepEqual(s.calls.map(call=>call[0]),[...remoteTextKeys('cat'),0xff08,...remoteTextKeys('r'),0xff08,0xff08,0xff08]);
});

test('emoji, non-Latin text and multiline paste use Unicode keysyms without the Latin-1 clipboard',()=>{
  const s=setup();s.button.fire('click');s.type('\u200bA한🙂\nB');
  assert.deepEqual(s.calls.map(call=>call[0]),[65,0x0100d55c,0x0101f642,0xff0d,66]);
  s.calls.length=0;s.type('\u200bA한🙂\n');assert.deepEqual(s.calls,[[0xff08,null]]);
});

test('Enter, navigation and physical shortcuts are forwarded once while printable keys use input events',()=>{
  const s=setup();s.button.fire('click');
  const printable=s.input.fire('keydown',{key:'a',code:'KeyA'});assert.equal(printable.prevented,undefined);assert.deepEqual(s.calls,[]);
  s.type('\u200ba');
  const enter=s.input.fire('keydown',{key:'Enter'});assert.equal(enter.prevented,true);
  const newline=s.input.fire('beforeinput',{inputType:'insertParagraph'});assert.equal(newline.prevented,true);
  s.input.fire('keydown',{key:'l',ctrlKey:true});
  assert.deepEqual(s.calls,[[97,null],[0xff0d,null],[0xff0d,null],[0xffe3,'ControlLeft',true],[108,null],[0xffe3,'ControlLeft',false]]);
});

test('touch taps retain the editable focus, while scrolling or multi-touch does not open a keyboard',()=>{
  const s=setup();s.button.fire('click');
  const down={target:s.viewport,pointerId:1,pointerType:'touch',clientX:20,clientY:40};
  s.viewport.fire('pointerdown',down);s.doc.activeElement=null;s.viewport.fire('pointerup',down);
  assert.equal(s.doc.activeElement,s.input);
  s.viewport.fire('pointerdown',down);s.doc.activeElement=null;s.viewport.fire('pointermove',{...down,clientY:65});s.viewport.fire('pointerup',down);
  assert.equal(s.doc.activeElement,null);
  s.viewport.fire('pointerdown',down);s.viewport.fire('pointerdown',{...down,pointerId:2,isPrimary:false});s.viewport.fire('pointerup',down);
  assert.equal(s.doc.activeElement,null);
});

test('disconnected and view-only sessions cannot open the keyboard or receive composed text',()=>{
  const s=setup();s.rfb.viewOnly=true;s.button.fire('click');assert.equal(s.keyboard.enabled,false);
  s.rfb.viewOnly=false;s.button.fire('click');s.input.fire('compositionstart');s.input.value='\u200b한';s.disconnect();s.input.fire('compositionend');
  assert.deepEqual(s.calls,[]);assert.equal(s.keyboard.focus(),false);
  s.keyboard.destroy();assert.equal(s.input.value,'');assert.equal(s.rfb.focusOnClick,true);
});
