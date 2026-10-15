import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// Custom properties declared in the first top-level :root block of a stylesheet.
function rootTokens(source) {
  const block = source.match(/(?:^|\n):root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}
const toPx = (value) => (value.endsWith('rem') ? parseFloat(value) * 16 : parseFloat(value));
const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const tokens = rootTokens(css('tokens.css'));
const glass = rootTokens(css('glass.css'));

test('every shared design token has its agreed value', () => {
  const sizes = { '--fs-xs': 12, '--fs-sm': 13, '--fs-md': 14, '--fs-body': 15, '--fs-lg': 16, '--fs-xl': 18, '--fs-2xl': 22 };
  for (const [name, px] of Object.entries(sizes)) assert.equal(toPx(tokens[name]), px, name);
  const exact = {
    '--fw-regular': '400', '--fw-medium': '500', '--fw-semibold': '600',
    '--radius-sm': '8px', '--radius-md': '12px', '--radius-lg': '16px', '--radius-xl': '22px', '--radius-pill': '999px',
    '--space-1': '4px', '--space-2': '8px', '--space-3': '12px', '--space-4': '16px', '--space-5': '20px', '--space-6': '24px',
    '--tap': '44px', '--accent': '#7956b5', '--accent-strong': '#654296', '--accent-soft': 'rgba(185, 156, 219, .16)',
    '--on-accent': '#fff', '--danger': '#b9425a', '--danger-text': '#aa3b60', '--success': '#3b7b68', '--warning': '#986622',
    '--z-raised': '5', '--z-sticky': '10', '--z-workspace': '30', '--z-dropdown': '40', '--z-drawer': '50', '--z-toast': '70',
  };
  for (const [name, value] of Object.entries(exact)) assert.equal(tokens[name], value, name);
  assert.match(tokens['--font-sans'], /Apple SD Gothic Neo.*Pretendard.*Malgun Gothic.*Noto Sans KR/);
  assert.match(tokens['--font-mono'], /^ui-monospace.*D2Coding/);
});

test('the type scale never goes below 12px', () => {
  const sizes = Object.entries(tokens).filter(([name]) => name.startsWith('--fs-')).map(([, value]) => toPx(value));
  assert.ok(sizes.length >= 7);
  assert.ok(Math.min(...sizes) >= 12);
});

test('secondary text and accents stay readable on the light glass theme', () => {
  // The canvas, a white panel and the violet light that sits behind the sidebar.
  for (const background of ['#eef1f4', '#ffffff', '#f1f4f7', '#dcd5f5']) {
    assert.ok(contrast(glass['--muted'], background) >= 4.5, `muted on ${background}`);
    assert.ok(contrast(glass['--dim'], background) >= 4.0, `dim on ${background}`);
  }
  for (const background of ['#eef1f4', '#ffffff']) assert.ok(contrast(glass['--dim'], background) >= 4.5, `dim on ${background}`);
  assert.ok(contrast(glass['--text'], '#dcd5f5') >= 7);
  assert.ok(contrast(tokens['--accent'], '#ffffff') >= 4.5, 'accent text on white');
  assert.ok(contrast('#ffffff', tokens['--accent']) >= 4.5, 'white text on accent');
  assert.ok(contrast('#ffffff', tokens['--danger']) >= 4.5, 'white text on danger');
  assert.ok(contrast(tokens['--danger-text'], '#ffffff') >= 4.5, 'danger text on white');
});
