/**
 * inspect.js — 実ファイルを調べるための調査CLI
 * =============================================================================
 * PDF/Wordの本文に科目名が書かれているかを確認するためのツール。
 * ここで「本文に正式名称がある」と分かれば、本文判定だけで初回から振り分けられる。
 *
 *   node back/inspect.js "C:\Users\me\Downloads\ICT入門⑧.pdf"
 *   node back/inspect.js --root "D:\大学\2026前期" "C:\...\prg1_202604_w11p_演習.pdf"
 *   node back/inspect.js --full "C:\...\file.pdf"     # 本文を全部出す
 *
 * --root を渡すと、そのフォルダ直下のフォルダ名を科目名とみなして
 * 「ファイル名に含まれるか / 本文に含まれるか」を判定する。
 * =============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractText } from './extract.js';
import { parseFileName, normalizeText, tokenize } from './learner.js';

// db.js（=better-sqlite3）に依存させないため、ここだけ同じロジックを持つ
const splitFolderName = (name) => String(name).split(/[,、，]/).map((s) => s.trim()).filter(Boolean);

const args = process.argv.slice(2);
const opts = { root: null, full: false, chars: 600, files: [] };

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opts.root = args[++i];
  else if (a === '--full') opts.full = true;
  else if (a === '--chars') opts.chars = Number(args[++i]);
  else opts.files.push(a);
}

if (opts.files.length === 0) {
  console.log('使い方: node inspect.js [--root <科目フォルダ>] [--full] <ファイル...>');
  process.exit(1);
}

/** --root から科目名の一覧を作る */
function loadSubjects(root) {
  if (!root) return [];
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    for (const name of splitFolderName(e.name)) {
      out.push({ name, folder: e.name, norm: normalizeText(name) });
    }
  }
  return out;
}

const subjectList = loadSubjects(opts.root);
if (subjectList.length) {
  console.log(`科目 ${subjectList.length} 件を ${opts.root} から読み込みました\n`);
}

const line = (c = '─') => console.log(c.repeat(72));

for (const file of opts.files) {
  line('═');
  console.log(`■ ${path.basename(file)}`);
  line('═');

  if (!fs.existsSync(file)) {
    console.log('  ファイルが見つかりません\n');
    continue;
  }

  // ---------- ファイル名の解析 ----------
  const p = parseFileName(path.basename(file));
  console.log('\n【ファイル名の解析】');
  console.log(`  NFKC正規化 : ${p.normalized}`);
  console.log(`  先頭トークン: ${p.head}    (数字を除いた形: ${p.headStem})`);
  console.log(`  週/回番号  : ${p.week ?? '(検出なし)'}`);
  console.log(`  日付       : ${p.date ? `${p.date.year}${p.date.month ? '-' + String(p.date.month).padStart(2, '0') : ''}${p.date.day ? '-' + String(p.date.day).padStart(2, '0') : ''}` : '(検出なし)'}`);
  console.log(`  トークン    : ${p.tokens.slice(0, 25).join(', ')}${p.tokens.length > 25 ? ' …' : ''}`);

  // ---------- 本文の抽出 ----------
  const r = await extractText(file, { maxChars: 50000 });
  console.log('\n【本文の抽出】');
  if (r.error) {
    console.log(`  失敗: ${r.error}`);
  } else {
    console.log(`  抽出器     : ${r.extractor}${r.pages ? ` / ${r.pages}ページ` : ''}`);
    console.log(`  文字数     : ${r.text.length}${r.truncated ? '（打ち切り）' : ''}`);
    if (r.text.length === 0) {
      console.log('  ※ テキストが0文字です。画像だけのPDF（スキャン）の可能性があります');
    } else {
      const head = opts.full ? r.text : r.text.slice(0, opts.chars);
      console.log('\n  ---- 本文 ----');
      console.log(head.split('\n').map((l) => '  ' + l).join('\n'));
      if (!opts.full && r.text.length > opts.chars) console.log(`  …（残り ${r.text.length - opts.chars} 文字）`);
      console.log('  --------------');
    }
  }

  // ---------- 科目名が含まれるか ----------
  if (subjectList.length) {
    const nameNorm = p.normalized;
    const textNorm = r.text ? normalizeText(r.text) : '';
    const inName = subjectList.filter((s) => nameNorm.includes(s.norm));
    const inText = subjectList.filter((s) => textNorm && textNorm.includes(s.norm));

    console.log('\n【科目名の検出】');
    console.log(`  ファイル名に含まれる: ${inName.length ? inName.map((s) => s.name).join(', ') : '(なし)'}`);
    console.log(`  本文に含まれる      : ${inText.length ? inText.map((s) => s.name).join(', ') : '(なし)'}`);

    if (!inName.length && !inText.length) {
      console.log('  → 科目名では特定できません。別名（略称）の登録か、手動配置の学習が必要です');
    } else if (!inName.length && inText.length) {
      console.log('  → 本文判定なら特定できます。content条件のルールが有効です');
    }
  }

  // ---------- 本文のトークン ----------
  if (r.text) {
    const ct = tokenize(r.text, { maxTerms: 40 });
    console.log(`\n【本文トークン(先頭40)】\n  ${ct.join(', ')}`);
  }
  console.log('');
}
