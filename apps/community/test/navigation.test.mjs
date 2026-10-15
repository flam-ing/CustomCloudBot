import test from 'node:test';
import assert from 'node:assert/strict';
import {sortMembers, filterMembers, memberRoleLabel, branchRowMeta, nextMenuIndex, placeMenu} from '../public/navigation.mjs';

test('participants list the owner first, then admins, then everyone by name', () => {
  const members = [
    {id:'1', displayName:'박준', role:'member'},
    {id:'2', displayName:'Ben', role:'member'},
    {id:'3', displayName:'운영자', role:'owner'},
    {id:'4', displayName:'가나다', role:'member'},
    {id:'5', displayName:'김관리', role:'admin'},
    {id:'6', displayName:'김민지', role:'member'},
  ];
  assert.deepEqual(sortMembers(members).map(member => member.id), ['3', '5', '4', '6', '1', '2']);
  assert.equal(members[0].id, '1', 'the input array is not reordered');
});

test('participant names compare numbers naturally and keep the original order for ties', () => {
  const members = [{id:'a', displayName:'팀원 10'}, {id:'b', displayName:'팀원 2'}, {id:'c', displayName:'팀원 2'}];
  assert.deepEqual(sortMembers(members).map(member => member.id), ['b', 'c', 'a']);
  assert.deepEqual(sortMembers([null, {id:'x', username:'zed'}, 'bad']).map(member => member.id), ['x']);
  assert.deepEqual(sortMembers(undefined), []);
});

test('participant search matches part of a name and ignores case and spaces', () => {
  const members = [{displayName:'Alexandria Konstantinopoulou'}, {displayName:'김민지'}, {displayName:'민수'}];
  assert.deepEqual(filterMembers(members, ' 민 ').map(member => member.displayName), ['김민지', '민수']);
  assert.deepEqual(filterMembers(members, 'ALEX').map(member => member.displayName), ['Alexandria Konstantinopoulou']);
  assert.equal(filterMembers(members, '').length, 3);
});

test('role labels are short Korean words', () => {
  assert.equal(memberRoleLabel('owner'), '방장');
  assert.equal(memberRoleLabel('admin'), '관리자');
  assert.equal(memberRoleLabel('member'), '멤버');
  assert.equal(memberRoleLabel(undefined), '멤버');
});

test('row captions say what a branch grew from, or who is in a conversation', () => {
  assert.equal(branchRowMeta({operation:'fork', parentNames:['디자인 회의방'], room:{}}), 'Fork · 디자인 회의방');
  assert.equal(branchRowMeta({operation:'merge', parentNames:['가', '나'], room:{pinned:true}}), '고정 · Merge · 가 + 나');
  assert.equal(branchRowMeta({operation:'fork', parentNames:[], room:{}}), 'Fork');
  assert.equal(branchRowMeta({operation:'root', room:{memberCount:3, description:'주간 점검'}}), '참여자 3명 · 주간 점검');
  assert.equal(branchRowMeta({operation:'root', room:{memberCount:1, description:''}}), '참여자 1명');
  assert.equal(branchRowMeta({operation:'root', room:{personal:true, memberCount:1}}), '나만의 대화');
  assert.equal(branchRowMeta({operation:'root', room:{personal:true, description:'메일 조회'}}), '메일 조회');
  assert.equal(branchRowMeta({operation:'root', room:{}}), '');
  assert.equal(branchRowMeta(), '');
});

test('arrow keys wrap around the menu and Home or End jump to the ends', () => {
  assert.equal(nextMenuIndex(-1, 'ArrowDown', 4), 0);
  assert.equal(nextMenuIndex(-1, 'ArrowUp', 4), 3);
  assert.equal(nextMenuIndex(3, 'ArrowDown', 4), 0);
  assert.equal(nextMenuIndex(0, 'ArrowUp', 4), 3);
  assert.equal(nextMenuIndex(2, 'Home', 4), 0);
  assert.equal(nextMenuIndex(1, 'End', 4), 3);
  assert.equal(nextMenuIndex(1, 'a', 4), 1);
  assert.equal(nextMenuIndex(0, 'ArrowDown', 0), -1);
});

test('menus open below their button and stay inside the window', () => {
  const viewport = {width:390, height:844}, size = {width:200, height:240};
  // Below the button, right edges lined up.
  assert.deepEqual(placeMenu({top:100, bottom:132, left:330, right:362}, size, viewport), {left:162, top:136});
  // No room below: the menu opens above the button.
  assert.deepEqual(placeMenu({top:700, bottom:732, left:330, right:362}, size, viewport), {left:162, top:456});
  // A button near the left edge never pushes the menu off screen.
  assert.equal(placeMenu({top:10, bottom:40, left:0, right:30}, size, viewport).left, 8);
  // A right-click point is used as the corner, then kept on screen.
  assert.deepEqual(placeMenu({x:380, y:830}, size, viewport), {left:182, top:596});
  // A menu taller than the window starts at the top margin.
  assert.equal(placeMenu({x:10, y:10}, {width:100, height:900}, viewport).top, 8);
});
