'use strict';
/**
 * learner.js — 「手動配置による自動学習」のコア（純粋関数のみ・外部依存なし）
 * -----------------------------------------------------------------------------
 * 仕組み:
 *   1. ユーザーが手でファイルを科目フォルダへ入れる／AIの判定を直す
 *      → learning_samples に1件記録
 *   2. ファイル名と本文を「語」に分解し term_stats の出現回数を加算
 *   3. 新しいファイルが来たら、その語からナイーブベイズで科目を推定
 *
 * 日本語は形態素解析器を入れず、2文字N-gram + 英数字単語で近似する。
 * （MeCab等の追加依存なしで exe 化できるのが利点）
 */

// よく出る助詞などのひらがな2gram。ノイズになるので除外する。
const HIRAGANA_STOP = new Set([
  'です', 'ます', 'した', 'して', 'する', 'ある', 'いる', 'この', 'その', 'あの',
  'これ', 'それ', 'から', 'まで', 'より', 'ため', 'とき', 'こと', 'もの', 'ない',
  'および', 'また', 'なお', 'ように', 'よう', 'ので', 'のみ', 'など', 'にて',
]);

const ASCII_STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'you',
  'pdf', 'docx', 'doc', 'pptx', 'xlsx', 'txt', 'file', 'download', 'copy',
  'final', 'new', 'ver', 'version', 'http', 'https', 'www', 'com',
]);

/** ひらがなのみで構成されているか */
function isAllHiragana(s) {
  return /^[ぁ-ゟ]+$/.test(s);
}

/**
 * テキストを語に分解する
 * @param {string} text
 * @param {{maxTerms?:number, isFileName?:boolean}} opts
 * @returns {string[]} 重複を除いた語のリスト
 */
function tokenize(text, opts = {}) {
  const { maxTerms = 400, isFileName = false } = opts;
  if (!text) return [];

  let s = String(text);
  if (isFileName) s = s.replace(/\.[a-z0-9]{1,6}$/i, ''); // 拡張子を落とす
  s = s.replace(/[_\-–—.,/\\()\[\]{}<>:;"'|!?＿－．，、。（）「」【】〈〉]/g, ' ');
  s = s.toLowerCase();

  const terms = new Set();

  // --- 英数字の単語 ---
  for (const m of s.match(/[a-z][a-z0-9+#]{1,23}/g) || []) {
    if (m.length >= 2 && !ASCII_STOP.has(m)) terms.add(m);
  }
  // 年度っぽい4桁数字だけ拾う（2026 など）
  for (const m of s.match(/\b(19|20)\d{2}\b/g) || []) terms.add(m);

  // --- 日本語（漢字・ひらがな・カタカナ）---
  const jpRuns = s.match(/[ぁ-ゟ゠-ヿ一-鿿ｦ-ﾟ]{2,}/g) || [];
  for (const run of jpRuns) {
    // 語全体（短ければキーワードとして強い）
    if (run.length <= 8 && !isAllHiragana(run)) terms.add(run);
    // 2-gram
    for (let i = 0; i < run.length - 1; i++) {
      const g = run.slice(i, i + 2);
      if (isAllHiragana(g) && HIRAGANA_STOP.has(g)) continue;
      terms.add(g);
    }
  }

  return [...terms].slice(0, maxTerms);
}

/**
 * ナイーブベイズによるスコア計算
 *
 * @param {object} p
 * @param {string[]} p.tokens                 判定対象の語
 * @param {Map<string, Map<number, number>>} p.termCounts  term -> (subjectId -> count)
 * @param {Map<number, {sampleCount:number, termTotal:number}>} p.subjectTotals
 * @param {number} p.vocabSize                この target の語彙数
 * @param {number} [p.alpha=0.5]              加算スムージング
 * @returns {Map<number, number>} subjectId -> 対数スコア
 */
function scoreLog({ tokens, termCounts, subjectTotals, vocabSize, alpha = 0.5 }) {
  const scores = new Map();
  if (subjectTotals.size === 0) return scores;

  let totalSamples = 0;
  for (const v of subjectTotals.values()) totalSamples += v.sampleCount;
  if (totalSamples <= 0) return scores;

  for (const [sid, tot] of subjectTotals) {
    // 事前確率
    let score = Math.log((tot.sampleCount + alpha) / (totalSamples + alpha * subjectTotals.size));
    const denom = tot.termTotal + alpha * Math.max(vocabSize, 1);
    for (const t of tokens) {
      const perSubject = termCounts.get(t);
      if (!perSubject) continue;             // 未知語は無視（標準的な扱い）
      const c = perSubject.get(sid) || 0;
      score += Math.log((c + alpha) / denom);
    }
    scores.set(sid, score);
  }
  return scores;
}

/** 複数targetの対数スコアを重み付きで合成する */
function combineLogScores(scoreMaps /* [{map, weight}] */) {
  const out = new Map();
  for (const { map, weight } of scoreMaps) {
    if (!map) continue;
    for (const [sid, v] of map) {
      out.set(sid, (out.get(sid) || 0) + v * (weight ?? 1));
    }
  }
  return out;
}

/**
 * 対数スコア → 確率（softmax）に変換して降順の配列で返す
 * @returns {Array<{subjectId:number, score:number, probability:number}>}
 */
function softmaxRank(logScores) {
  const entries = [...logScores.entries()];
  if (entries.length === 0) return [];
  const max = Math.max(...entries.map(([, v]) => v));
  const exps = entries.map(([sid, v]) => [sid, Math.exp(v - max)]);
  const sum = exps.reduce((a, [, e]) => a + e, 0) || 1;
  return exps
    .map(([sid, e], i) => ({
      subjectId: sid,
      score: entries[i][1],
      probability: e / sum,
    }))
    .sort((a, b) => b.probability - a.probability);
}

/**
 * ある科目を特徴づける語を選ぶ（学習結果からルールを自動生成するのに使う）
 * スコア = その科目での出現数 / 全体での出現数 × log(出現数+1)
 *
 * @param {Array<{term:string, count:number, totalCount:number}>} rows
 * @param {{minCount?:number, topN?:number, minRatio?:number}} opts
 */
function pickDistinctiveTerms(rows, opts = {}) {
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

module.exports = {
  tokenize,
  scoreLog,
  combineLogScores,
  softmaxRank,
  pickDistinctiveTerms,
  HIRAGANA_STOP,
  ASCII_STOP,
};
