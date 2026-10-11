import test from 'node:test';
import assert from 'node:assert/strict';
import {sendChromeShortcut} from '../public/desktop.js';

const capture=()=>{
  const events=[];
  return {events,rfb:{sendKey:(...args)=>events.push(args),focus:()=>events.push(['focus'])}};
};

test('Chrome incognito sends uppercase N keysym with Control and Shift held',()=>{
  const {rfb,events}=capture();sendChromeShortcut(rfb,'n',true);
  assert.deepEqual(events,[
    [0xffe3,'ControlLeft',true],
    [0xffe1,'ShiftLeft',true],
    [0x4e,'KeyN'],
    [0xffe1,'ShiftLeft',false],
    [0xffe3,'ControlLeft',false],
    ['focus'],
  ]);
});

test('unshifted Chrome new-tab and location shortcuts preserve lowercase keysyms',()=>{
  for(const [letter,keysym]of[['t',0x74],['l',0x6c]]){
    const {rfb,events}=capture();sendChromeShortcut(rfb,letter);
    assert.deepEqual(events,[[0xffe3,'ControlLeft',true],[keysym,'Key'+letter.toUpperCase()],[0xffe3,'ControlLeft',false],['focus']]);
  }
});
