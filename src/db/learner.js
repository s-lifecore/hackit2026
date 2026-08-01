/**
 * learner.js — 「手動配置による自動学習」のコア（純粋関数のみ・外部依存なし）
 * =============================================================================
 * 仕組み:
 *   1. ユーザーが手でファイルを科目フォルダへ入れる／AIの判定を直す
 *      → learning_samples に1件記録
 *   2. ファイル名と本文を「語」に分解し term_stats の出現回数を加算
 *   3. 新しいファイルが来たら、その語からナイーブベイズで科目を推定
 *
 * 日本語は形態素解析器を入れず、2文字N-gram + 英数字単語で近似する。
 * （MeCab等の追加依存なしで exe 化できるのが利点）
 *
 * 実ファイル名の調査から分かったこと:
 *   PD入門_2026_w13_おもちゃ開発3.pdf   → プロジェクト演習入門
 *   prg1_202604_w11p_演習.pdf          → 知能情報プログラミング１
 *   ICT入門⑧.pdf                       → ICT入門
 *
 *   - 科目略称は必ず「先頭」にある            → head に重い重みをつける
 *   - 週番号の表記が w13 / w11p / ⑧ とバラバラ → NFKC正規化してから構造化して抜く
 *   - 日付や週番号は毎回変わる                 → 語彙に混ぜるとノイズなので除去する
 * =============================================================================
 */

/**
 * NFKC正規化 + 小文字化。
 *   ⑧ → 8 ／ １ → 1 ／ Ａ → A ／ ｱ → ア
 * これを通さないと「イングリッシュトピックス１」と「…1」が別語になる。
 */
export function normalizeText(s) {
  if (s == null) return '';
  return String(s).normalize('NFKC').toLowerCase();
}

/** 拡張子を落とす */
export function stripExt(fileName) {
  return String(fileName || '').replace(/\.[a-z0-9]{1,6}$/i, '');
}

/**
 * 日本語のうしろに付くローマ数字を算用数字にする。
 *
 * 実PDFの調査で判明した問題:
 *   フォルダ名 : 知能情報プログラミング１   （全角の1 → NFKCで "1"）
 *   資料の本文 : 知能情報プログラミングI    （ラテン文字の I → NFKCで "i"）
 * NFKCだけでは "1" と "i" が別物のままで一致しない。
 */
const ROMAN_MAP = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9,
  x: 10, xi: 11, xii: 12,
};
const ROMAN_RE = /([^\x00-\x7F])[ 　]?(viii|vii|vi|iv|ix|iii|ii|xii|xi|x|v|i)(?![a-z0-9])/g;

export function romanNumeralsToDigits(s) {
  return String(s).replace(ROMAN_RE, (m, prev, roman) => prev + (ROMAN_MAP[roman] ?? roman));
}

/**
 * 科目名・別名の照合に使う正規化。
 * NFKC + 小文字化 + ローマ数字の算用数字化 + 記号と空白の除去。
 *   「知能情報プログラミングI」「知能情報プログラミング１」「知能情報プログラミング 1」
 *   → いずれも「知能情報プログラミング1」
 */
export function normalizeSubjectKey(s) {
  if (s == null) return '';
  let t = normalizeText(s);
  t = romanNumeralsToDigits(t);
  // 資料中では「ICT入門」「Ｉ ＣＴ入門」のように空白や記号が挟まることがある
  return t.replace(/[\s_\-–—・･,、，.。:：;；|｜/／\\]+/g, '');
}

/** hay の中に needle が何回出てくるか（重なりなし） */
export function countOccurrences(hay, needle) {
  if (!hay || !needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// よく出る助詞などのひらがな2gram。ノイズになるので除外する。
export const HIRAGANA_STOP = new Set([
  'です', 'ます', 'した', 'して', 'する', 'ある', 'いる', 'この', 'その', 'あの',
  'これ', 'それ', 'から', 'まで', 'より', 'ため', 'とき', 'こと', 'もの', 'ない',
  'および', 'また', 'なお', 'ように', 'よう', 'ので', 'のみ', 'など', 'にて',
]);

export const ASCII_STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'you',
  'pdf', 'docx', 'doc', 'pptx', 'xlsx', 'txt', 'file', 'download', 'copy',
  'final', 'new', 'ver', 'version', 'http', 'https', 'www', 'com',
]);

const isAllHiragana = (s) => /^[ぁ-ゟ]+$/.test(s);

/* ============================================================================
 * ファイル名の構造解析
 * ==========================================================================*/

/** 週番号 / 回数。w13, w11p, 第3回, 3回目, week5 */
const WEEK_PATTERNS = [
  /\bw(\d{1,2})p?\b/,
  /\bweek\s*(\d{1,2})\b/,
  /第\s*(\d{1,2})\s*回/,
  /(\d{1,2})\s*回目/,
];

/**
 * 丸数字 ①〜㊿。「ICT入門⑧」のように第n回の意味で使われる。
 * NFKC正規化すると普通の数字になってしまうため、正規化前に拾う必要がある。
 */
const CIRCLED_RE = /[①-⑳㉑-㉟㊱-㊿]/;

export function circledToNumber(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x2460 && c <= 0x2473) return c - 0x2460 + 1;   // ①〜⑳
  if (c >= 0x3251 && c <= 0x325f) return c - 0x3251 + 21;  // ㉑〜㉟
  if (c >= 0x32b1 && c <= 0x32bf) return c - 0x32b1 + 36;  // ㊱〜㊿
  return null;
}

/** 日付。20260415 / 202604 / 2026-04-15 / 2026 */
const DATE_PATTERNS = [
  /\b(20\d{2})[-_./](\d{1,2})[-_./](\d{1,2})\b/,
  /\b(20\d{2})(\d{2})(\d{2})\b/,
  /\b(20\d{2})(\d{2})\b/,
  /\b(20\d{2})\b/,
];

/**
 * ファイル名を構造化して分解する。
 *
 * @param {string} fileName 例: 'prg1_202604_w11p_演習.pdf'
 * @returns {{
 *   normalized: string,   // 'prg1_202604_w11p_演習'（NFKC・小文字）
 *   head: string,         // 'prg1'    科目略称の最有力候補
 *   headStem: string,     // 'prg'     末尾数字を落としたもの
 *   week: number|null,    // 11
 *   date: {year:number, month:number|null, day:number|null}|null,
 *   rest: string,         // 日付と週番号を除いた残り（トークン化の対象）
 *   tokens: string[]
 * }}
 */
export function parseFileName(fileName) {
  const rawBase = stripExt(fileName);

  // --- 丸数字（正規化前に拾う。⑧ は 8 ではなく「第8回」の意味）---
  let week = null;
  let rawForHead = rawBase;
  const cm = rawBase.match(CIRCLED_RE);
  if (cm) {
    week = circledToNumber(cm[0]);
    rawForHead = rawBase.replace(CIRCLED_RE, ' ');
  }

  // 別名の部分一致に使うので、こちらは元の文字列をそのまま正規化する
  const normalized = normalizeText(rawBase);

  // --- 週番号（w13 / 第3回 など）---
  // 注意: 正規表現の \b は アンダースコアを「単語の一部」とみなすため、
  //       'pd入門_w13_...' では \bw13\b が成立しない。先に空白へ置換しておく。
  let stripped = normalizeText(rawForHead).replace(/_+/g, ' ');
  if (week == null) {
    for (const re of WEEK_PATTERNS) {
      const m = stripped.match(re);
      if (m) {
        week = Number(m[1]);
        stripped = stripped.replace(re, ' ');
        break;
      }
    }
  }

  // --- 日付 ---
  let date = null;
  for (const re of DATE_PATTERNS) {
    const m = stripped.match(re);
    if (m) {
      date = {
        year: Number(m[1]),
        month: m[2] != null ? Number(m[2]) : null,
        day: m[3] != null ? Number(m[3]) : null,
      };
      stripped = stripped.replace(re, ' ');
      break;
    }
  }

  // --- 先頭トークン（科目略称）---
  // 区切り記号で割った最初のかたまり。区切りが無ければ先頭の連続部分。
  // 丸数字は取り除いた文字列を使う（「ICT入門⑧」→「ict入門」）
  const firstSeg = normalizeText(rawForHead)
    .split(/[_\-–—\s.,/\\()[\]{}<>:;|]+/).filter(Boolean)[0] || '';
  const head = firstSeg;
  // 'prg1' → 'prg' / 'ict入門8' → 'ict入門'。科目番号と週番号のどちらか分からないため両方残す
  const headStem = firstSeg.replace(/\d+$/, '') || firstSeg;

  const rest = stripped.trim();
  const tokens = tokenize(rest, { maxTerms: 80, alreadyNormalized: true });

  // head は必ずトークンに含める（区切りで消えないように）
  for (const t of [head, headStem]) {
    if (t && t.length >= 2 && !tokens.includes(t)) tokens.push(t);
  }

  return { normalized, head, headStem, week, date, rest, tokens };
}

/* ============================================================================
 * トークナイザ
 * ==========================================================================*/

/**
 * テキストを語に分解する
 * @param {string} text
 * @param {{maxTerms?:number, isFileName?:boolean, alreadyNormalized?:boolean}} opts
 * @returns {string[]} 重複を除いた語のリスト
 */
export function tokenize(text, opts = {}) {
  const { maxTerms = 400, isFileName = false, alreadyNormalized = false } = opts;
  if (!text) return [];

  let s = alreadyNormalized ? String(text) : normalizeText(isFileName ? stripExt(text) : text);
  s = s.replace(/[_\-–—.,/\\()[\]{}<>:;"'|!?＿－．，、。（）「」【】〈〉]/g, ' ');

  const terms = new Set();

  // --- 英数字の単語 ---
  for (const m of s.match(/[a-z][a-z0-9+#]{1,23}/g) || []) {
    if (m.length >= 2 && !ASCII_STOP.has(m)) terms.add(m);
  }
  // 年度っぽい4桁数字だけ拾う（2026 など）。それ以外の数字は捨てる
  for (const m of s.match(/\b(19|20)\d{2}\b/g) || []) terms.add(m);

  // --- 日本語（漢字・ひらがな・カタカナ）---
  const jpRuns = s.match(/[ぁ-ゟ゠-ヿ一-鿿ｦ-ﾟ]{2,}/g) || [];
  for (const run of jpRuns) {
    if (run.length <= 8 && !isAllHiragana(run)) terms.add(run);
    for (let i = 0; i < run.length - 1; i++) {
      const g = run.slice(i, i + 2);
      if (isAllHiragana(g) && HIRAGANA_STOP.has(g)) continue;
      terms.add(g);
    }
  }

  return [...terms].slice(0, maxTerms);
}

/* ============================================================================
 * ナイーブベイズ
 * ==========================================================================*/

/**
 * @param {object} p
 * @param {string[]} p.tokens
 * @param {Map<string, Map<number, number>>} p.termCounts  term -> (subjectId -> count)
 * @param {Map<number, {sampleCount:number, termTotal:number}>} p.subjectTotals
 * @param {number} p.vocabSize
 * @param {number} [p.alpha=0.5]
 * @returns {Map<number, number>} subjectId -> 対数スコア
 */
export function scoreLog({ tokens, termCounts, subjectTotals, vocabSize, alpha = 0.5 }) {
  const scores = new Map();
  if (subjectTotals.size === 0) return scores;

  let totalSamples = 0;
  for (const v of subjectTotals.values()) totalSamples += v.sampleCount;
  if (totalSamples <= 0) return scores;

  for (const [sid, tot] of subjectTotals) {
    let score = Math.log((tot.sampleCount + alpha) / (totalSamples + alpha * subjectTotals.size));
    const denom = tot.termTotal + alpha * Math.max(vocabSize, 1);
    for (const t of tokens) {
      const perSubject = termCounts.get(t);
      if (!perSubject) continue; // 未知語は無視（標準的な扱い）
      const c = perSubject.get(sid) || 0;
      score += Math.log((c + alpha) / denom);
    }
    scores.set(sid, score);
  }
  return scores;
}

/** 複数targetの対数スコアを重み付きで合成する */
export function combineLogScores(scoreMaps /* [{map, weight}] */) {
  const out = new Map();
  for (const { map, weight } of scoreMaps) {
    if (!map) continue;
    for (const [sid, v] of map) out.set(sid, (out.get(sid) || 0) + v * (weight ?? 1));
  }
  return out;
}

/** 対数スコア → 確率（softmax）。降順の配列で返す */
export function softmaxRank(logScores) {
  const entries = [...logScores.entries()];
  if (entries.length === 0) return [];
  const max = Math.max(...entries.map(([, v]) => v));
  const exps = entries.map(([sid, v]) => [sid, Math.exp(v - max)]);
  const sum = exps.reduce((a, [, e]) => a + e, 0) || 1;
  return exps
    .map(([sid, e], i) => ({ subjectId: sid, score: entries[i][1], probability: e / sum }))
    .sort((a, b) => b.probability - a.probability);
}

/**
 * ある科目を特徴づける語を選ぶ（学習結果からルール／別名を自動生成するのに使う）
 * @param {Array<{term:string, count:number, totalCount:number}>} rows
 */
export function pickDistinctiveTerms(rows, opts = {}) {
  const { minCount = 2, topN = 8, minRatio = 0.6 } = opts;
  return rows
    .filter((r) => r.count >= minCount && r.count / r.totalCount >= minRatio)
    .map((r) => ({
      term: r.term,
      count: r.count,
      ratio: r.count / r.totalCount,
      score: (r.count / r.totalCount) * Math.log(r.count + 1),
    }))
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, topN);
}
