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

/** Map the scaled VNC canvas back to native desktop screen coordinates. */
export function remoteInputAt(canvas,regions,clientX,clientY) {
  const rect=canvas.getBoundingClientRect();
  if(!(rect.width>0&&rect.height>0&&canvas.width>0&&canvas.height>0))return null;
  const x=(clientX-rect.left)*canvas.width/rect.width,y=(clientY-rect.top)*canvas.height/rect.height;
  if(x<0||y<0||x>=canvas.width||y>=canvas.height)return null;
  return regions.find(r=>[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0&&x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height)||null;
}

/** Focus a real editable during the native touch gesture, never after an awaited
 * server reply. The caller supplies cached native input bounds before each tap.
 */
export function createRemoteKeyboard({rfb,viewport,canInput=()=>true,onChange=()=>{}}) {
  const doc=viewport.ownerDocument,input=doc.createElement('textarea'),listeners=[];
  input.className='workspace-remote-keyboard';input.rows=1;input.maxLength=4096;
  input.setAttribute('aria-label','원격 브라우저 키보드 입력');
  input.setAttribute('autocapitalize','off');input.setAttribute('autocorrect','off');
  input.setAttribute('autocomplete','off');input.setAttribute('spellcheck','false');
  input.setAttribute('inputmode','text');input.setAttribute('data-lpignore','true');
  input.tabIndex=-1;input.disabled=true;viewport.append(input);
  let enabled=false,disposed=false,composing=false,previous=SEED,canvas=null;
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
    if(enabled)focus();else input.blur();
    onChange(enabled);
    return enabled;
  };
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
    // text/IME after tapping a remote text field, without echoes.
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
    // Commit to the old remote field before noVNC moves the remote caret.
    if(enabled&&event.target!==input){composing=false;flush();reset();}
  },true);
  reset();
  return {
    focus,
    setEnabled,
    bindCanvas(target,{getRegions,onInvalidate=()=>{}}) {
      if(canvas||disposed)return;
      canvas=target;
      // noVNC emits this synchronously inside touchend, after its remote click.
      // Register after RFB connect: focusing/resizing earlier changes click coords.
      listen(canvas,'gesturestart',event=>{
        if(!ready())return;
        const tap=event.detail?.type==='onetap';
        const region=tap?remoteInputAt(canvas,getRegions(),event.detail.clientX,event.detail.clientY):null;
        if(region){
          input.setAttribute('inputmode',['text','email','url','tel','numeric','decimal','search'].includes(region.inputMode)?region.inputMode:'text');
          setEnabled(true);
        }else if(enabled)setEnabled(false);
        onInvalidate({clear:!region});
      });
      const moving=event=>{if(event.detail?.type!=='onetap')onInvalidate();};
      listen(canvas,'gesturemove',moving);
      listen(canvas,'gestureend',moving);
      listen(canvas,'wheel',()=>onInvalidate(),{passive:true});
      listen(canvas,'mouseup',()=>{if(enabled)setEnabled(false);onInvalidate();});
    },
    get enabled(){return enabled;},
    destroy(){if(disposed)return;setEnabled(false);disposed=true;for(const remove of listeners)remove();input.value='';input.remove();},
  };
}
