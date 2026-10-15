import test from 'node:test';
import assert from 'node:assert/strict';
import {createRemoteKeyboard,remoteTextKeys,remoteInputAt} from '../public/remote-keyboard.js';

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
  const doc={activeElement:null,createElement(){return new Element(this);}},viewport=new Element(doc),canvas=new Element(doc),calls=[];
  let connected=true;
  const rfb={viewOnly:false,focusOnClick:true,sendKey:(...args)=>calls.push(args)};
  const keyboard=createRemoteKeyboard({rfb,viewport,canInput:()=>connected});
  canvas.width=1280;canvas.height=800;canvas.getBoundingClientRect=()=>({left:20,top:40,width:640,height:400});
  let regions=[{x:100,y:80,width:300,height:50,inputMode:'url'}],invalidations=0;
  keyboard.bindCanvas(canvas,{getRegions:()=>regions,onInvalidate:({clear=true}={})=>{invalidations++;if(clear)regions=[];}});
  const input=viewport.children[0],type=value=>{input.value=value;input.fire('input');};
  return{doc,viewport,canvas,calls,rfb,keyboard,input,type,setRegions:value=>{regions=value;},get invalidations(){return invalidations;},disconnect:()=>{connected=false;}};
}

test('a native input tap focuses synchronously without a keyboard button and cleans up',()=>{
  const s=setup();assert.equal(s.input.disabled,true);assert.equal(s.doc.activeElement,null);
  s.canvas.fire('gesturestart',{detail:{type:'onetap',clientX:80,clientY:90}});
  assert.equal(s.doc.activeElement,s.input);assert.equal(s.input.disabled,false);assert.equal(s.rfb.focusOnClick,false);
  assert.equal(s.input.attributes.inputmode,'url');
  s.type('\u200bprivate text');s.canvas.fire('gesturestart',{detail:{type:'onetap',clientX:300,clientY:300}});
  assert.equal(s.keyboard.enabled,false);assert.equal(s.doc.activeElement,null);assert.equal(s.rfb.focusOnClick,true);
  assert.equal(s.input.value,'\u200b');assert.equal(s.input.disabled,true);
  s.keyboard.destroy();assert.equal(s.viewport.children.length,0);assert.equal(s.input.value,'');
  for(const element of [s.viewport,s.canvas,s.input])for(const handlers of element.handlers.values())assert.equal(handlers.size,0);
});

test('Korean IME commits once and handles composition-end trailing input without duplicate text',()=>{
  const s=setup();s.keyboard.setEnabled(true);s.input.fire('compositionstart');
  s.input.value='\u200bㅎ';s.input.fire('input',{isComposing:true});
  s.input.value='\u200b한';s.input.fire('input',{isComposing:true});assert.deepEqual(s.calls,[]);
  s.input.fire('compositionend');s.input.fire('input');
  assert.deepEqual(s.calls,[[0x01000000|'한'.codePointAt(0),null]]);
  s.input.fire('compositionstart');s.input.value='\u200b한글';s.input.fire('compositionend');s.input.fire('input');
  assert.deepEqual(s.calls.map(call=>call[0]),remoteTextKeys('한글'));
});

test('mobile input-only backspace works at an empty field and text replacement does not delete the seed remotely',()=>{
  const s=setup();s.keyboard.setEnabled(true);s.type('');s.type('');
  assert.deepEqual(s.calls,[[0xff08,null],[0xff08,null]]);
  s.calls.length=0;s.type('\u200bcat');s.type('\u200bcar');s.type('');
  assert.deepEqual(s.calls.map(call=>call[0]),[...remoteTextKeys('cat'),0xff08,...remoteTextKeys('r'),0xff08,0xff08,0xff08]);
});

test('emoji, non-Latin text and multiline paste use Unicode keysyms without the Latin-1 clipboard',()=>{
  const s=setup();s.keyboard.setEnabled(true);s.type('\u200bA한🙂\nB');
  assert.deepEqual(s.calls.map(call=>call[0]),[65,0x0100d55c,0x0101f642,0xff0d,66]);
  s.calls.length=0;s.type('\u200bA한🙂\n');assert.deepEqual(s.calls,[[0xff08,null]]);
});

test('Enter, navigation and physical shortcuts are forwarded once while printable keys use input events',()=>{
  const s=setup();s.keyboard.setEnabled(true);
  const printable=s.input.fire('keydown',{key:'a',code:'KeyA'});assert.equal(printable.prevented,undefined);assert.deepEqual(s.calls,[]);
  s.type('\u200ba');
  const enter=s.input.fire('keydown',{key:'Enter'});assert.equal(enter.prevented,true);
  const newline=s.input.fire('beforeinput',{inputType:'insertParagraph'});assert.equal(newline.prevented,true);
  s.input.fire('keydown',{key:'l',ctrlKey:true});
  assert.deepEqual(s.calls,[[97,null],[0xff0d,null],[0xff0d,null],[0xffe3,'ControlLeft',true],[108,null],[0xffe3,'ControlLeft',false]]);
});

test('scroll, pinch, right-click, empty or expired input maps never open the keyboard',()=>{
  const s=setup(),detail={clientX:80,clientY:90};
  for(const type of ['twodrag','drag','pinch','longpress','twotap']){
    s.canvas.fire('gesturestart',{detail:{...detail,type}});
    assert.equal(s.doc.activeElement,null);assert.equal(s.keyboard.enabled,false);
  }
  s.setRegions([]);s.canvas.fire('gesturestart',{detail:{...detail,type:'onetap'}});
  assert.equal(s.doc.activeElement,null);assert.equal(s.invalidations,6);
  s.keyboard.setEnabled(true);s.canvas.fire('gesturestart',{detail:{...detail,type:'twodrag'}});
  assert.equal(s.keyboard.enabled,false);
});

test('scaled and letterboxed canvas targets use actual native bounds without guessing toolbar positions',()=>{
  const s=setup(),regions=[{x:100,y:80,width:300,height:50}];
  assert.equal(remoteInputAt(s.canvas,regions,80,90),regions[0]);
  assert.equal(remoteInputAt(s.canvas,regions,19,90),null);
  assert.equal(remoteInputAt(s.canvas,regions,220,90),null);
  assert.equal(remoteInputAt(s.canvas,[{x:100,y:80,width:Infinity,height:50}],80,90),null);
  s.canvas.getBoundingClientRect=()=>({left:10,top:200,width:320,height:200});
  assert.equal(remoteInputAt(s.canvas,regions,40,225),regions[0]);
});

test('repeated taps in the same input retain the cached target until a fresh map arrives',()=>{
  const s=setup(),detail={type:'onetap',clientX:80,clientY:90};
  s.canvas.fire('gesturestart',{detail});s.canvas.fire('gestureend',{detail});
  assert.equal(s.keyboard.enabled,true);
  s.canvas.fire('gesturestart',{detail});s.canvas.fire('gestureend',{detail});
  assert.equal(s.keyboard.enabled,true);assert.equal(s.doc.activeElement,s.input);
  s.canvas.fire('gesturemove',{detail:{type:'twodrag'}});
  s.canvas.fire('gesturestart',{detail});assert.equal(s.keyboard.enabled,false);
});

test('remote click is delivered before keyboard focus or layout changes',()=>{
  const s=setup(),order=[];
  // A real noVNC registers its own non-bubbling gesture handler before bindCanvas.
  const [keyboardHandler]=s.canvas.handlers.get('gesturestart');
  s.canvas.handlers.set('gesturestart',new Set([()=>order.push('remote-click'),keyboardHandler]));
  s.input.focus=()=>{order.push('local-focus');s.doc.activeElement=s.input;};
  s.canvas.fire('gesturestart',{detail:{type:'onetap',clientX:80,clientY:90}});
  assert.deepEqual(order,['remote-click','local-focus']);
  assert.equal(s.doc.activeElement,s.input);
});

test('disconnected and view-only sessions cannot open the keyboard or receive composed text',()=>{
  const s=setup();s.rfb.viewOnly=true;s.keyboard.setEnabled(true);assert.equal(s.keyboard.enabled,false);
  s.rfb.viewOnly=false;s.keyboard.setEnabled(true);s.input.fire('compositionstart');s.input.value='\u200b한';s.disconnect();s.input.fire('compositionend');
  assert.deepEqual(s.calls,[]);assert.equal(s.keyboard.focus(),false);
  s.keyboard.destroy();assert.equal(s.input.value,'');assert.equal(s.rfb.focusOnClick,true);
});
