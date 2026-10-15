// Safe rich text for chat transcripts. Message text is parsed into a small tree
// and every piece of text becomes a text node; no message ever reaches innerHTML.

export function safeLink(value) {
  try {const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}
}

const MAX_DEPTH = 6;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
// Three digits at most, so dates such as "2026. 10. 16." stay ordinary text.
const ITEM = /^( *)([-*+]|\d{1,3}[.)])[ \t]+(.*)$/;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function splitRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '', code = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (char === '`') code = !code;
    if (char === '|' && !code) { cells.push(cell.trim()); cell = ''; continue; }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}
function tableStart(lines, index) {
  const head = lines[index], rule = lines[index + 1];
  if (!head?.includes('|') || rule === undefined || !rule.includes('-') || !TABLE_RULE.test(rule)) return null;
  const header = splitRow(head), align = splitRow(rule);
  if (header.length !== align.length || header.length < 1) return null;
  return {header, align: align.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '')};
}
const indentOf = line => line.match(/^ */)[0].length;
function startsBlock(lines, index) {
  const line = lines[index];
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || Boolean(tableStart(lines, index));
}

function parseList(lines, start, depth) {
  const first = lines[start].match(ITEM);
  const ordered = /\d/.test(first[2]);
  const indent = first[1].length;
  const list = {type: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items: []};
  let index = start;
  while (index < lines.length) {
    const match = lines[index].match(ITEM);
    if (!match || match[1].length !== indent || /\d/.test(match[2]) !== ordered || (RULE.test(lines[index]) && !ordered)) break;
    const offset = match[1].length + match[2].length + 1;
    const content = [match[3]];
    index++;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        let next = index + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next < lines.length && indentOf(lines[next]) > indent) { content.push(...lines.slice(index, next).map(() => '')); index = next; continue; }
        break;
      }
      const lineIndent = indentOf(line);
      if (lineIndent > indent) { content.push(line.slice(Math.min(lineIndent, offset))); index++; continue; }
      if (startsBlock(lines, index) || !content.at(-1)?.trim()) break;
      content.push(line.trim());
      index++;
    }
    let task = null;
    const box = content[0].match(/^\[([ xX])\][ \t]+/);
    if (box) { task = box[1] !== ' '; content[0] = content[0].slice(box[0].length); }
    list.items.push({task, children: parseBlocks(content, depth + 1)});
    let next = index;
    while (next < lines.length && !lines[next].trim()) next++;
    const following = lines[next]?.match(ITEM);
    if (next > index && following && following[1].length === indent && /\d/.test(following[2]) === ordered) { list.loose = true; index = next; }
  }
  return {block: list, next: index};
}

/** Parses message markdown into plain block objects; the result holds no markup strings. */
export function parseBlocks(input, depth = 0) {
  const lines = Array.isArray(input) ? input : String(input ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks = [];
  let paragraph = [];
  const flush = () => { if (paragraph.length) blocks.push({type: 'paragraph', text: paragraph.join('\n')}); paragraph = []; };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { flush(); index++; continue; }
    if (depth >= MAX_DEPTH) { paragraph.push(line.trim()); index++; continue; }
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const marker = fence[1], body = [];
      const indent = indentOf(line);
      index++;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`).test(lines[index])) {
        body.push(lines[index].slice(Math.min(indent, indentOf(lines[index]))));
        index++;
      }
      index++;
      blocks.push({type: 'code', lang: fence[2] || '', text: body.join('\n')});
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) { flush(); blocks.push({type: 'heading', level: heading[1].length, text: heading[2]}); index++; continue; }
    if (RULE.test(line)) { flush(); blocks.push({type: 'rule'}); index++; continue; }
    const table = tableStart(lines, index);
    if (table) {
      flush();
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = splitRow(lines[index]);
        rows.push(table.header.map((_, cell) => cells[cell] ?? ''));
        index++;
      }
      blocks.push({type: 'table', ...table, rows});
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const body = [];
      while (index < lines.length && QUOTE.test(lines[index])) { body.push(lines[index].match(QUOTE)[1]); index++; }
      blocks.push({type: 'quote', children: parseBlocks(body, depth + 1)});
      continue;
    }
    const item = line.match(ITEM);
    // A numbered line only starts a list inside a paragraph when it counts from 1.
    if (item && (!paragraph.length || !/\d/.test(item[2]) || Number.parseInt(item[2], 10) === 1)) {
      flush();
      const {block, next} = parseList(lines, index, depth);
      blocks.push(block);
      index = next;
      continue;
    }
    paragraph.push(paragraph.length ? line.trim() : line.trimStart());
    index++;
  }
  flush();
  return blocks;
}

const URL_CHARS = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'*+,;=%";
const INLINE = new RegExp([
  "\\\\([\\\\`*_{}\\[\\]()#+\\-.!|~>])",
  "(`+)([^`]|[^`][\\s\\S]*?[^`])\\2(?!`)",
  "!?\\[([^\\]\\n]+)\\]\\(\\s*<?([^\\s<>()]+(?:\\([^\\s<>()]*\\)[^\\s<>()]*)*)>?(?:\\s+(?:\"[^\"\\n]*\"|'[^'\\n]*'))?\\s*\\)",
  "<(https?:\\/\\/[^\\s<>]+)>",
  `(https?:\\/\\/[${URL_CHARS}]+(?:\\([${URL_CHARS}]*\\)[${URL_CHARS}]*)*)`,
  "\\*\\*(?=\\S)([\\s\\S]*?\\S)\\*\\*",
  "__(?=\\S)([\\s\\S]*?\\S)__(?![A-Za-z0-9])",
  "~~(?=\\S)([\\s\\S]*?\\S)~~",
  "(?<![*\\w])\\*(?=[^\\s*])([^*\\n]*?[^\\s*])\\*(?![*\\w])",
  "(?<![_A-Za-z0-9\\u00C0-\\uFFFF])_(?=[^\\s_])([^_\\n]*?[^\\s_])_(?![_A-Za-z0-9\\u00C0-\\uFFFF])",
].join('|'), 'g');

function pushText(tokens, text) {
  if (!text) return;
  const last = tokens.at(-1);
  if (last?.type === 'text') last.text += text;
  else tokens.push({type: 'text', text});
}
/** Splits inline markdown into text, strong, em, del, code and link tokens. */
export function parseInline(input, depth = 0, inLink = false) {
  const text = String(input ?? '');
  const tokens = [];
  if (depth > MAX_DEPTH) { pushText(tokens, text); return tokens; }
  let end = 0;
  for (const match of text.matchAll(INLINE)) {
    pushText(tokens, text.slice(end, match.index));
    end = match.index + match[0].length;
    if (match[1] !== undefined) pushText(tokens, match[1]);
    else if (match[2] !== undefined) tokens.push({type: 'code', text: match[3].length > 2 && match[3].startsWith(' ') && match[3].endsWith(' ') ? match[3].slice(1, -1) : match[3]});
    else if (inLink && (match[4] !== undefined || match[6] !== undefined || match[7] !== undefined)) pushText(tokens, match[4] ?? match[0]);
    else if (match[4] !== undefined) {
      const href = safeLink(match[5]);
      if (href) tokens.push({type: 'link', href, children: parseInline(match[4], depth + 1, true)});
      else pushText(tokens, match[0]);
    } else if (match[6] !== undefined || match[7] !== undefined) {
      let url = match[6] ?? match[7], trail = '';
      if (match[7] !== undefined) {
        while (/[.,;:!?'"*]$/.test(url) || (url.endsWith(')') && (url.match(/\(/g)?.length || 0) < (url.match(/\)/g)?.length || 0))) { trail = url.at(-1) + trail; url = url.slice(0, -1); }
      }
      const href = safeLink(url);
      if (href) tokens.push({type: 'link', href, children: [{type: 'text', text: url}]});
      else pushText(tokens, url);
      pushText(tokens, trail);
    } else if (match[8] !== undefined || match[9] !== undefined) tokens.push({type: 'strong', children: parseInline(match[8] ?? match[9], depth + 1, inLink)});
    else if (match[10] !== undefined) tokens.push({type: 'del', children: parseInline(match[10], depth + 1, inLink)});
    else tokens.push({type: 'em', children: parseInline(match[11] ?? match[12], depth + 1, inLink)});
  }
  pushText(tokens, text.slice(end));
  return tokens;
}

function inlineText(tokens) {
  return tokens.map(token => token.type === 'text' || token.type === 'code' ? token.text : inlineText(token.children || [])).join('');
}
function blockText(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'paragraph' || block.type === 'heading') parts.push(inlineText(parseInline(block.text)));
    else if (block.type === 'code') parts.push(block.text);
    else if (block.type === 'quote') parts.push(blockText(block.children));
    else if (block.type === 'list') for (const item of block.items) parts.push(blockText(item.children));
    else if (block.type === 'table') for (const row of [block.header, ...block.rows]) parts.push(row.map(cell => inlineText(parseInline(cell))).filter(Boolean).join(' · '));
  }
  return parts.filter(Boolean).join(' ');
}
/** Plain words for previews such as notifications: no #, **, | or list markers. */
export function plainTextPreview(value, max = 180) {
  const text = blockText(parseBlocks(value)).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, Math.max(1, max - 1)).join('').trimEnd() + '…';
}

/** Human messages longer than this are folded behind a "더 보기" button. */
export function isLongMessage(value, {lines = 15, chars = 600} = {}) {
  const text = String(value ?? '');
  return text.length > chars || text.split('\n').length > lines;
}

const INVISIBLE_START = /^[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800\uFE00-\uFE0F]+/u;
/** First visible character, keeping emoji and combined Hangul whole. */
export function firstGrapheme(value, fallback = '?') {
  const text = String(value ?? '').replace(INVISIBLE_START, '');
  if (!text) return fallback;
  let first;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') first = new Intl.Segmenter('ko', {granularity: 'grapheme'}).segment(text)[Symbol.iterator]().next().value?.segment;
  else first = Array.from(text)[0];
  return first ? first.toLocaleUpperCase('ko') : fallback;
}

/** Text color that stays readable on a profile color (#rgb or #rrggbb). */
export function readableTextOn(color, light = '#fff', dark = '#2e3242') {
  const hex = String(color || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!hex) return '';
  const full = hex.length === 3 ? [...hex].map(char => char + char).join('') : hex;
  const [r, g, b] = [0, 2, 4].map(at => Number.parseInt(full.slice(at, at + 2), 16) / 255).map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Contrast against white versus against the dark text color (#2e3242, luminance 0.0325).
  return (1.05 / (luminance + 0.05)) >= ((luminance + 0.05) / 0.0825) ? light : dark;
}

/** Whether a message continues the previous one from the same person. */
export function continuesGroup(previous, message, windowMs = 5 * 60 * 1000) {
  if (!previous || !message || previous.kind !== 'human' || message.kind !== 'human') return false;
  if (!previous.authorId || previous.authorId !== message.authorId || previous.pending === 'failed') return false;
  const gap = Number(message.createdAt) - Number(previous.createdAt);
  if (!Number.isFinite(gap) || gap < 0 || gap > windowMs) return false;
  return new Date(previous.createdAt).toDateString() === new Date(message.createdAt).toDateString();
}

/**
 * Display box for a picture: never larger than the original, at most `max` on each
 * side and at least `min`. Extreme shapes are cropped only when that needs no upscaling.
 */
export function imageBox(width, height, {min = 80, max = 320} = {}) {
  const w = Number(width), h = Number(height);
  if (!(w > 0 && h > 0)) return null;
  const scale = Math.min(1, max / w, max / h);
  const boxWidth = Math.round(Math.min(max, Math.max(min, w * scale)));
  const boxHeight = Math.round(Math.min(max, Math.max(min, h * scale)));
  const cover = Math.max(boxWidth / w, boxHeight / h);
  return {width: boxWidth, height: boxHeight, fit: cover <= 1 ? 'cover' : 'scale-down'};
}

/** "0:05", "12:03", "1:02:03" */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
/** "5초", "1분 3초" for screen readers. */
export function spokenDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return [h && `${h}시간`, m && `${m}분`, (s || !(h || m)) && `${s}초`].filter(Boolean).join(' ');
}

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
function appendText(node, text) {
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index) node.append(document.createElement('br'));
    if (line) node.append(document.createTextNode(line));
  });
}
function appendInline(node, tokens) {
  for (const token of tokens) {
    if (token.type === 'text') { appendText(node, token.text); continue; }
    if (token.type === 'code') { const code = element('code'); code.textContent = token.text; node.append(code); continue; }
    const child = element(token.type === 'link' ? 'a' : token.type);
    if (token.type === 'link') { child.href = token.href; child.target = '_blank'; child.rel = 'noopener noreferrer'; }
    appendInline(child, token.children || []);
    node.append(child);
  }
}
function codeBlock(block) {
  const wrap = element('div', 'code-block');
  const header = element('div', 'code-header');
  const label = element('span');
  label.textContent = block.lang || '코드';
  const button = element('button');
  button.type = 'button';
  button.textContent = '복사';
  button.setAttribute('aria-label', '코드 복사');
  button.onclick = async () => {
    try { await navigator.clipboard.writeText(block.text); button.textContent = '복사됨'; }
    catch { button.textContent = '복사 실패'; }
    clearTimeout(button._reset);
    button._reset = setTimeout(() => { button.textContent = '복사'; }, 2000);
  };
  header.append(label, button);
  const pre = element('pre'), code = element('code');
  code.textContent = block.text;
  pre.append(code);
  wrap.append(header, pre);
  return wrap;
}
function renderBlocks(parent, blocks, tight = false) {
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      if (tight) { appendInline(parent, parseInline(block.text)); continue; }
      const node = element('div', 'rich-paragraph');
      appendInline(node, parseInline(block.text));
      parent.append(node);
    } else if (block.type === 'heading') {
      // The page and panes own h1/h2; message headings start one level below.
      const node = element(`h${Math.min(6, block.level + 2)}`, 'rich-heading');
      appendInline(node, parseInline(block.text));
      parent.append(node);
    } else if (block.type === 'code') parent.append(codeBlock(block));
    else if (block.type === 'rule') parent.append(element('hr'));
    else if (block.type === 'quote') { const node = element('blockquote'); renderBlocks(node, block.children); parent.append(node); }
    else if (block.type === 'list') {
      const list = element(block.ordered ? 'ol' : 'ul');
      if (block.ordered && block.start !== 1) list.start = block.start;
      for (const item of block.items) {
        const li = element('li');
        if (item.task !== null) {
          li.className = 'rich-task';
          const box = element('input');
          box.type = 'checkbox';
          box.disabled = true;
          box.checked = item.task;
          li.append(box);
        }
        // Tight lists keep their words directly in the item, like "- 하나".
        renderBlocks(li, item.children, !block.loose);
        list.append(li);
      }
      parent.append(list);
    } else if (block.type === 'table') {
      const wrap = element('div', 'rich-table');
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'region');
      wrap.setAttribute('aria-label', '표');
      const table = element('table'), head = element('thead'), body = element('tbody');
      const row = (cells, tag) => {
        const tr = element('tr');
        cells.forEach((cell, index) => {
          const node = element(tag);
          if (tag === 'th') node.scope = 'col';
          if (block.align[index]) node.style.textAlign = block.align[index];
          appendInline(node, parseInline(cell));
          tr.append(node);
        });
        return tr;
      };
      head.append(row(block.header, 'th'));
      block.rows.forEach(cells => body.append(row(cells, 'td')));
      table.append(head);
      if (block.rows.length) table.append(body);
      wrap.append(table);
      parent.append(wrap);
    }
  }
}
export function renderMessageText(value){
  const root = element('div', 'message-copy');
  renderBlocks(root, parseBlocks(value));
  return root;
}
