import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBlocks, parseInline, plainTextPreview, renderMessageText, isLongMessage, firstGrapheme,
  readableTextOn, continuesGroup, imageBox, formatDuration, spokenDuration,
} from '../public/message-format.mjs';

// A small stand-in for the DOM: enough to render messages and print them back.
function fakeDocument() {
  class Text { constructor(text) { this.nodeType = 3; this.data = text; } }
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.className = ''; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    set textContent(value) { this.children = [new Text(String(value))]; }
    get textContent() { return this.children.map(child => child.nodeType === 3 ? child.data : child.textContent).join(''); }
    set innerHTML(_) { throw new Error('innerHTML must not be used'); }
  }
  return {createElement: tag => new Element(tag), createTextNode: text => new Text(text)};
}
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function html(node) {
  if (node.nodeType === 3) return escape(node.data);
  const tag = node.tagName.toLowerCase();
  const attrs = [node.className && `class="${node.className}"`, node.href && `href="${node.href}"`, node.start && `start="${node.start}"`].filter(Boolean).join(' ');
  return `<${tag}${attrs ? ' ' + attrs : ''}>${node.children.map(html).join('')}</${tag}>`;
}
function render(markdown) {
  globalThis.document = fakeDocument();
  try { return html(renderMessageText(markdown)); } finally { delete globalThis.document; }
}

test('bot replies render headings, lists, quotes, rules and tables as real structure', () => {
  const out = render('## 정리\n\n- 하나\n- 둘\n  1. 안쪽\n\n3. 셋째\n4. 넷째\n\n> 인용\n\n---\n\n| 항목 | 담당 |\n|:--|--:|\n| 디자인 | 민지 |');
  assert.match(out, /<h4 class="rich-heading">정리<\/h4>/);
  assert.match(out, /<ul><li>하나<\/li><li>둘<ol><li>안쪽<\/li><\/ol><\/li><\/ul>/);
  assert.match(out, /<ol start="3"><li>셋째<\/li><li>넷째<\/li><\/ol>/);
  assert.match(out, /<blockquote><div class="rich-paragraph">인용<\/div><\/blockquote>/);
  assert.match(out, /<hr><\/hr>/);
  assert.match(out, /<div class="rich-table"><table><thead><tr><th>항목<\/th><th>담당<\/th><\/tr><\/thead><tbody><tr><td>디자인<\/td><td>민지<\/td><\/tr><\/tbody><\/table><\/div>/);
  const table = parseBlocks('| a | b |\n|:-:|--:|\n| x \\| y | `c|d` |')[0];
  assert.deepEqual(table.align, ['center', 'right']);
  assert.deepEqual(table.rows, [['x | y', '`c|d`']]);
});

test('markup in message text stays text and only http(s) links without credentials become links', () => {
  const out = render('<img src=x onerror=alert(1)> [나쁜](javascript:alert(1)) [좋은](https://example.com/a) https://user:pw@example.com **<b>굵게</b>**');
  assert.doesNotMatch(out, /<img|<b>|javascript:"|href="javascript/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /\[나쁜\]\(javascript:alert\(1\)\)/);
  assert.match(out, /<a href="https:\/\/example.com\/a">좋은<\/a>/);
  assert.doesNotMatch(out, /href="https:\/\/user/);
  assert.match(out, /<strong>&lt;b&gt;굵게&lt;\/b&gt;<\/strong>/);
});

test('code fences keep their text exactly and lines break inside paragraphs', () => {
  const blocks = parseBlocks('앞\n```js\nconst a = "<b>";\n  b();\n```\n뒤 첫 줄\n뒤 둘째 줄');
  assert.deepEqual(blocks[1], {type: 'code', lang: 'js', text: 'const a = "<b>";\n  b();'});
  assert.equal(blocks[2].text, '뒤 첫 줄\n뒤 둘째 줄');
  assert.match(render('한 줄\n두 줄'), /한 줄<br><\/br>두 줄/);
  const unclosed = parseBlocks('```\n끝나지 않은 코드');
  assert.equal(unclosed[0].type, 'code');
});

test('fenced source preserves tabs, literal markup and embedded shorter fences', () => {
  const source = '\tconst label = "<script>alert(1)</script>";\n\t```\n\treturn label;';
  const blocks = parseBlocks('````js\r\n' + source.replace(/\n/g, '\r\n') + '\r\n````');
  assert.deepEqual(blocks, [{type: 'code', lang: 'js', text: source}]);
  const out = render('````js\n' + source + '\n````');
  assert.match(out, /\tconst label = "&lt;script&gt;alert\(1\)&lt;\/script&gt;";/);
  assert.doesNotMatch(out, /<script|<a|<strong/);
});

test('tables retain pipes inside multi-backtick code and loose list paragraphs stay separate', () => {
  const table = parseBlocks('| code | value |\n|---|---|\n| ``a|`b`|c`` | done |')[0];
  assert.deepEqual(table.rows, [['``a|`b`|c``', 'done']]);
  assert.match(render('- 첫 문단\n\n  둘째 문단\n- 다음 항목'), /<li><div class="rich-paragraph">첫 문단<\/div><div class="rich-paragraph">둘째 문단<\/div><\/li>/);
});

test('unsafe URLs and raw HTML remain inert inside tables, lists and quotes', () => {
  const unsafe = [
    '[스크립트](javascript:alert(1))',
    '[데이터](data:text/html;base64,PHNjcmlwdD4=)',
    '[파일](file:///etc/passwd)',
    '[계정](https://user:password@example.com)',
    '[상대](//example.com)',
    '<img src=x onerror=alert(1)>',
  ].join(' ');
  const out = render(`| 제목 |\n|---|\n| ${unsafe} |\n\n- ${unsafe}\n\n> ${unsafe}`);
  assert.doesNotMatch(out, /<a\b|<img\b|<script\b/);
  assert.equal((out.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length, 3);
  assert.match(out, /<table>/);
  assert.match(out, /<ul>/);
  assert.match(out, /<blockquote>/);
});

test('safe links open separately without opener access and markdown images never load remotely', () => {
  const previous = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    const tree = renderMessageText('[문서](https://example.com/docs) ![그림](https://example.com/image.png)');
    const elements = [];
    const visit = node => { if (node.nodeType !== 3) { elements.push(node); node.children.forEach(visit); } };
    visit(tree);
    const links = elements.filter(node => node.tagName === 'A');
    assert.equal(links.length, 2);
    for (const link of links) {
      assert.equal(link.target, '_blank');
      assert.equal(link.rel, 'noopener noreferrer');
    }
    assert.ok(!elements.some(node => ['IMG', 'IFRAME', 'SCRIPT'].includes(node.tagName)));
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test('inline marks, autolinks and plain words that only look like markup', () => {
  const tokens = parseInline('**굵게** *기울임* ~~취소~~ `코드` snake_case_name 2*3*4 https://example.com/a(b). 끝');
  assert.deepEqual(tokens.filter(token => token.type !== 'text').map(token => token.type), ['strong', 'em', 'del', 'code', 'link']);
  assert.equal(tokens.find(token => token.type === 'link').href, 'https://example.com/a(b)');
  assert.ok(tokens.some(token => token.type === 'text' && token.text.includes('snake_case_name 2*3*4 ')));
  assert.ok(tokens.some(token => token.type === 'text' && token.text.startsWith('. 끝')));
  const nested = parseInline('[**굵은** https://a.com](https://b.com)')[0];
  assert.equal(nested.type, 'link');
  assert.ok(!JSON.stringify(nested.children).includes('"link"'), 'links never nest');
  assert.equal(parseInline('\\*별표\\*')[0].text, '*별표*');
});

test('dates and numbers at the start of a line are not mistaken for lists', () => {
  assert.equal(parseBlocks('2026. 10. 16. 회의')[0].type, 'paragraph');
  assert.equal(parseBlocks('설명입니다\n2. 이어지는 문장')[0].type, 'paragraph');
  assert.equal(parseBlocks('설명입니다\n- 항목')[1].type, 'list');
});

test('notification previews drop markdown symbols but keep the words', () => {
  assert.equal(plainTextPreview('## 정리\n\n**세 줄로** 정리했어요.\n\n| 항목 | 담당 |\n|---|---|\n| 디자인 | 민지 |\n\n- [링크](https://a.com) 확인'),
    '정리 세 줄로 정리했어요. 항목 · 담당 디자인 · 민지 링크 확인');
  assert.equal(plainTextPreview('가'.repeat(300), 10), '가'.repeat(9) + '…');
  assert.equal(plainTextPreview(''), '');
});

test('long human messages fold by length or line count', () => {
  assert.equal(isLongMessage('짧은 글'), false);
  assert.equal(isLongMessage('가'.repeat(601)), true);
  assert.equal(isLongMessage(Array.from({length: 16}, () => '줄').join('\n')), true);
  assert.equal(isLongMessage(Array.from({length: 15}, () => '줄').join('\n')), false);
});

test('avatar letters keep whole emoji and skip invisible characters; text color follows the profile color', () => {
  assert.equal(firstGrapheme('👩‍💻민지'), '👩‍💻');
  assert.equal(firstGrapheme('​ㅤ 준'), '준');
  assert.equal(firstGrapheme('kim'), 'K');
  assert.equal(firstGrapheme(''), '?');
  assert.equal(readableTextOn('#6f658e'), '#fff');
  assert.equal(readableTextOn('#f4e7a1'), '#2e3242');
  assert.equal(readableTextOn('#abc'), '#2e3242');
  assert.equal(readableTextOn('purple'), '');
});

test('consecutive messages group only for the same person, the same day and within five minutes', () => {
  const at = new Date(2026, 9, 16, 12, 0).getTime();
  const human = (authorId, createdAt, extra = {}) => ({kind: 'human', authorId, createdAt, ...extra});
  assert.equal(continuesGroup(human('a', at), human('a', at + 60_000)), true);
  assert.equal(continuesGroup(human('a', at), human('a', at + 6 * 60_000)), false);
  assert.equal(continuesGroup(human('a', at), human('b', at + 1000)), false);
  assert.equal(continuesGroup({kind: 'bot', author: '검토', createdAt: at}, {kind: 'bot', author: '검토', createdAt: at + 1000}), false);
  assert.equal(continuesGroup(human('a', at, {pending: 'failed'}), human('a', at + 1000)), false);
  assert.equal(continuesGroup(null, human('a', at)), false);
  const lateNight = new Date(2026, 9, 16, 23, 59).getTime();
  assert.equal(continuesGroup(human('a', lateNight), human('a', lateNight + 2 * 60_000)), false);
});

test('picture boxes never enlarge the original and stay between 80 and 320 pixels', () => {
  assert.deepEqual(imageBox(512, 512), {width: 320, height: 320, fit: 'cover'});
  assert.deepEqual(imageBox(900, 1200), {width: 240, height: 320, fit: 'cover'});
  assert.deepEqual(imageBox(3000, 100), {width: 320, height: 80, fit: 'cover'});
  assert.deepEqual(imageBox(40, 40), {width: 80, height: 80, fit: 'scale-down'});
  assert.deepEqual(imageBox(400, 50), {width: 320, height: 80, fit: 'scale-down'});
  assert.equal(imageBox(0, 10), null);
  assert.equal(imageBox(undefined, undefined), null);
});

test('voice lengths read as clock time and as words', () => {
  assert.equal(formatDuration(5.4), '0:05');
  assert.equal(formatDuration(723), '12:03');
  assert.equal(formatDuration(3723), '1:02:03');
  assert.equal(formatDuration(NaN), '0:00');
  assert.equal(spokenDuration(5), '5초');
  assert.equal(spokenDuration(63), '1분 3초');
  assert.equal(spokenDuration(120), '2분');
  assert.equal(spokenDuration(0), '0초');
});
