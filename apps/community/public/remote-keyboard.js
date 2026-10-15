const SEED = '\u200b';
const SPECIAL_KEYS = {Enter:0xff0d,Tab:0xff09,Escape:0xff1b,Backspace:0xff08,Delete:0xffff,ArrowLeft:0xff51,ArrowUp:0xff52,ArrowRight:0xff53,ArrowDown:0xff54,Home:0xff50,End:0xff57,PageUp:0xff55,PageDown:0xff56};
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined,{granularity:'grapheme'}) : null;
const characters = text => segmenter ? Array.from(segmenter.segment(text),part=>part.segment) : Array.from(text);

// Unicode keysyms avoid the legacy VNC clipboard's Latin-1 replacement of Korean.
export function remoteTextKeys(text) {
  return Array.from(text,character=>{
    const point=character.codePointAt(0);
    return point===10?0xff0d:point===9?0xff09:point<=0xff?point:0x01000000|point;
  });
}

/** A real editable, focused synchronously by a user gesture, opens phone keyboards.
 * The remote screen is pixels: the keyboard button is explicit because it cannot
 * identify text fields, and opening a keyboard on every canvas tap blocks browsing.
 */
export function createRemoteKeyboard({rfb,viewport,button,canInput=()=>true,onChange=()=>{}}) {
  const doc=viewport.ownerDocument,input=doc.createElement('textarea'),listeners=[];
  input.className='workspace-remote-keyboard';input.rows=1;input.maxLength=4096;
  input.setAttribute('aria-label','원격 브라우저 키보드 입력');
  input.setAttribute('autocapitalize','off');input.setAttribute('autocorrect','off');
  input.setAttribute('autocomplete','off');input.setAttribute('spellcheck','false');
  input.setAttribute('inputmode','text');input.setAttribute('data-lpignore','true');
  input.tabIndex=-1;input.disabled=true;viewport.append(input);
  let enabled=false,disposed=false,composing=false,previous=SEED,touch=null;
  const originalFocusOnClick=rfb.focusOnClick;
  const ready=()=>!disposed&&canInput()&&!rfb.viewOnly;
  const listen=(target,type,handler,options)=>{target.addEventListener(type,handler,options);listeners.push(()=>target.removeEventListener(type,handler,options));};
  const reset=()=>{previous=SEED;input.value=SEED;input.setSelectionRange?.(SEED.length,SEED.length);};
  const send=keysym=>{if(ready())rfb.sendKey(keysym,null);};
  const flush=()=>{
    if(!enabled||!ready()||composing)return;
    const next=input.value;
    if(next===previous)return;
    const before=characters(previous.replaceAll(SEED,'')),after=characters(next.replaceAll(SEED,''));let common=0;
    if(previous===SEED&&next==='')send(SPECIAL_KEYS.Backspace);
    while(common<before.length&&common<after.length&&before[common]===after[common])common++;
    for(let i=common;i<before.length;i++)send(SPECIAL_KEYS.Backspace);
    for(const keysym of remoteTextKeys(after.slice(common).join('')))send(keysym);
    previous=next;
    // Keep only a small editing buffer, and always leave a character to delete:
    // mobile keyboards often send input events instead of a Backspace key event.
    if(!next||after.length>256)reset();
  };
  const focus=({clear=false}={})=>{
    if(!enabled||!ready())return false;
    if(clear){composing=false;reset();}
    rfb.focusOnClick=false;
    input.focus({preventScroll:true});
    input.setSelectionRange?.(input.value.length,input.value.length);
    return true;
  };
  const setEnabled=value=>{
    enabled=!!value&&ready();composing=false;reset();input.disabled=!enabled;
    rfb.focusOnClick=enabled?false:originalFocusOnClick;
    button.setAttribute('aria-pressed',String(enabled));
    button.setAttribute('aria-label',enabled?'원격 키보드 닫기':'원격 키보드 열기');
    button.title=enabled?'키보드 닫기':'입력칸을 선택한 뒤 키보드 열기';
    if(enabled)focus();else input.blur();
    onChange(enabled);
    return enabled;
  };
  listen(button,'click',()=>setEnabled(!enabled));
  listen(input,'compositionstart',()=>{composing=true;});
  listen(input,'compositionend',()=>{composing=false;flush();});
  listen(input,'input',event=>{if(!event.isComposing)flush();});
  listen(input,'beforeinput',event=>{
    if(!enabled||!ready()||composing||event.isComposing)return;
    if(event.inputType==='insertLineBreak'||event.inputType==='insertParagraph'){
      event.preventDefault();send(SPECIAL_KEYS.Enter);reset();
    }
  });
  listen(input,'keydown',event=>{
    // The canvas keeps noVNC's physical-keyboard path. This sibling editable owns
    // text/IME only while the explicit keyboard mode is selected, without echoes.
    event.stopPropagation();
    if(!enabled||!ready()||composing||event.isComposing||event.keyCode===229)return;
    const special=SPECIAL_KEYS[event.key];
    const modified=event.ctrlKey||event.altKey||event.metaKey;
    if(!special&&!modified)return;
    const point=event.key?.length===1?event.key.codePointAt(0):null;
    if(!special&&!point)return;
    event.preventDefault();
    const modifiers=[];
    if(event.ctrlKey||event.metaKey)modifiers.push([0xffe3,'ControlLeft']);
    if(event.altKey)modifiers.push([0xffe9,'AltLeft']);
    if(event.shiftKey)modifiers.push([0xffe1,'ShiftLeft']);
    for(const [key,code]of modifiers)rfb.sendKey(key,code,true);
    try{send(special??(point<=0xff?point:0x01000000|point));}
    finally{for(const [key,code]of modifiers.reverse())rfb.sendKey(key,code,false);}
    reset();
  });
  listen(input,'keyup',event=>event.stopPropagation());
  listen(input,'blur',()=>{composing=false;flush();reset();});
  listen(viewport,'pointerdown',event=>{
    if(!enabled||event.target===input)return;
    composing=false;flush();reset();
    touch=event.isPrimary!==false&&(event.pointerType==='touch'||event.button===0)?{id:event.pointerId,x:event.clientX,y:event.clientY}:null;
  },true);
  listen(viewport,'pointermove',event=>{
    if(touch&&event.pointerId===touch.id&&Math.hypot(event.clientX-touch.x,event.clientY-touch.y)>12)touch=null;
  },true);
  listen(viewport,'pointerup',event=>{if(touch&&event.pointerId===touch.id)focus();touch=null;},true);
  listen(viewport,'pointercancel',()=>{touch=null;},true);
  reset();button.setAttribute('aria-pressed','false');button.title='입력칸을 선택한 뒤 키보드 열기';
  return {
    focus,
    setEnabled,
    get enabled(){return enabled;},
    destroy(){if(disposed)return;setEnabled(false);disposed=true;for(const remove of listeners)remove();input.value='';input.remove();},
  };
}
