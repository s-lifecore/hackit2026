'use strict';
/**
 * html.test.js — 画面のHTMLが壊れていないかを機械的に検査する
 *   実行: node test/html.test.js
 *
 * 何度か「CSSが画面に文字として表示される」不具合が起きたため、
 * ビルド前に必ず気づけるようにした。
 *
 * index.html は2500行を超える1枚もので、その大半が <style> の中身。
 * マージや編集で <style> の対応が崩れると、CSSがそのまま本文として表示される。
 * 見た目が派手に壊れる割に、コードを読んでも原因が分かりにくい種類の事故なので、
 * ここで検出する。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
};

const file = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const html = fs.readFileSync(file, 'utf8');

console.log('\n[1] style / script タグの対応');
{
  const open  = (html.match(/<style[\s>]/gi)  || []).length;
  const close = (html.match(/<\/style\s*>/gi) || []).length;
  check(`<style> と </style> の数が一致（開き${open} 閉じ${close}）`, open === close && open > 0);

  const sOpen  = (html.match(/<script[\s>]/gi)  || []).length;
  const sClose = (html.match(/<\/script\s*>/gi) || []).length;
  check(`<script> と </script> の数が一致（開き${sOpen} 閉じ${sClose}）`, sOpen === sClose && sOpen > 0);
}

console.log('\n[2] CSSが本文へ漏れていない');
{
  // <style>…</style> を取り除いた残りに、CSSらしい文字列が出てこないか
  const body = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ');

  const suspects = [
    ['color:var(',   /color\s*:\s*var\(/],
    ['padding:var(', /padding\s*:\s*var\(/],
    ['@keyframes',   /@keyframes/],
    ['@media',       /@media\s*\(/],
    ['display:grid', /display\s*:\s*grid/]
  ];
  for (const [name, re] of suspects) {
    const m = body.match(re);
    check(`本文に "${name}" が出てこない`, !m,
      m ? body.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ') : '');
  }
}

console.log('\n[3] style の中身が途中で切れていない');
{
  const m = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  check('<style> が見つかる', !!m);
  if (m) {
    const css = m[1];
    const ob = (css.match(/{/g) || []).length;
    const cb = (css.match(/}/g) || []).length;
    check(`波かっこの数が一致（{ ${ob} / } ${cb}）`, ob === cb);
    check('CSSの最後がコメント途中で終わっていない',
      (css.match(/\/\*/g) || []).length === (css.match(/\*\//g) || []).length);
    check('主要なスタイルが最後まで含まれている',
      css.includes('.workspace{') && css.includes('.tutorial-list{') && css.includes('@media'));
  }
}

console.log('\n[4] 画面から参照しているIDがHTMLに存在する');
{
  const script = (html.match(/<script>([\s\S]*?)<\/script>/i) || [])[1] || '';
  const ids = new Set();
  for (const m of script.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(m[1]);
  const missing = [...ids].filter(id => !new RegExp(`id=["']${id}["']`).test(html));
  check(`getElementById の参照先がすべて存在する（${ids.size}件）`, missing.length === 0, missing.join(', '));
}

console.log('\n[5] head の中身が表示されない保険');
{
  // ブラウザ標準スタイルが読み込まれなかった場合でも、
  // <title> や <style> の中身が本文として表示されないようにしてある
  const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || '';
  const rule = css.match(/head[^{]*,[^{]*style[^{]*{[^}]*display\s*:\s*none[^}]*}/i);
  check('head/title/style を非表示にする指定がある', !!rule, '（PC起動時にCSSが文字で出る事故の対策）');
  check('その指定が !important 付き', !!rule && /!important/.test(rule[0]));
}

console.log('\n[6] 文字コードとタグの基本');
{
  check('BOM が付いていない', !html.startsWith('﻿'));
  check('<meta charset="UTF-8"> がある', /<meta\s+charset=["']?utf-8/i.test(html));
  check('</html> で終わっている', /<\/html>\s*$/i.test(html));
  check('マージの衝突マーカーが残っていない', !/^(<<<<<<<|=======$|>>>>>>>)/m.test(html));
}

console.log(`\n結果: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
