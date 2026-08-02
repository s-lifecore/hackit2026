'use strict';
/**
 * tokenize.js — 日本語まじりテキストの軽量トークナイザ
 *
 * 形態素解析器（MeCab / kuromoji）は辞書が重くexeが肥大化するため使わない。
 * 代わりに「CJKは文字N-gram、英数字は単語」という方式を採る。
 * 日本語の検索エンジンで広く使われる手法で、辞書なしでも科目名の一致判定に十分機能する。
 */

const RE_ALNUM = /[a-z0-9]+/g;
// ひらがな・カタカナ・漢字・長音符
const RE_CJK = /[ぁ-ゖァ-ヺー々一-鿿豈-﫿㐀-䶿]+/g;

/** ノイズになりやすい機能語・汎用語（1〜2文字のCJK N-gram中心） */
const STOP = new Set([
  'する', 'した', 'して', 'ます', 'ませ', 'です', 'ある', 'あり', 'いる', 'この', 'その',
  'こと', 'もの', 'ため', 'よう', 'れる', 'られ', 'から', 'まで', 'また', 'なる', 'なっ',
  'とい', 'いう', 'って', 'では', 'には', 'とし', 'ての', 'ように', 'ついて',
  'the', 'and', 'for', 'you', 'with', 'this', 'that', 'from', 'are', 'not', 'can',
  'pdf', 'docx', 'pptx', 'xlsx', 'doc', 'ppt', 'xls', 'txt', 'zip', 'copy', 'final',
  'ダウンロード', 'download'
]);

/** 全角/半角・大文字小文字・区切り記号をならす */
function normalize(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_\-–—.,()（）\[\]{}<>「」『』【】・:;!?"'`~@#$%^&*+=|\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * トークン列を返す。
 * @param {string} raw
 * @param {{ngram?:number, keepStop?:boolean}} opt
 * @returns {string[]}
 */
function tokenize(raw, opt = {}) {
  const n = opt.ngram || 2;
  const text = normalize(raw);
  const out = [];

  // 英数字：そのまま単語として拾う。数字と英字が混ざる場合は英字部分も別トークンにする
  //（例: "prg1" -> "prg1", "prg" / "w13" -> "w13", "w"は1文字なので捨てる）
  let m;
  RE_ALNUM.lastIndex = 0;
  while ((m = RE_ALNUM.exec(text)) !== null) {
    const w = m[0];
    if (w.length >= 2 && !/^\d+$/.test(w)) out.push(w);
    const alpha = w.replace(/\d+/g, '');
    if (alpha.length >= 2 && alpha !== w) out.push(alpha);
  }

  // CJK：連続する塊ごとに N-gram を作る
  RE_CJK.lastIndex = 0;
  while ((m = RE_CJK.exec(text)) !== null) {
    const run = m[0];
    if (run.length < n) {
      if (run.length >= 1) out.push(run);
      continue;
    }
    for (let i = 0; i + n <= run.length; i++) out.push(run.slice(i, i + n));
    // 短い語（2〜4文字）はまるごとも1トークンとして加える。科目名の完全一致を強く効かせるため
    if (run.length >= 3 && run.length <= 6) out.push(run);
  }

  return opt.keepStop ? out : out.filter(t => !STOP.has(t));
}

/** トークン -> 出現回数 の Map */
function countTokens(raw, opt) {
  const map = new Map();
  for (const t of tokenize(raw, opt)) map.set(t, (map.get(t) || 0) + 1);
  return map;
}

/** ファイル名から拡張子を落とした本体部分 */
function stem(fileName) {
  return String(fileName || '').replace(/\.[^.]{1,8}$/, '');
}

module.exports = { normalize, tokenize, countTokens, stem, STOP };
