'use strict';
/**
 * classifier.js — ルールベースの振り分け判定エンジン
 *
 * 考え方
 *  1. 科目ごとに「プロフィール」（重み付きトークン集合）を作る。
 *       - フォルダ名（科目名）        … 重み 3.0
 *       - ユーザーが指定したキーワード … 重み 5.0
 *       - 手動振り分けから学習した語   … 出現に応じて加算
 *  2. ファイル（ファイル名＋内容）のトークン集合と突き合わせ、
 *     「その科目のプロフィールのうち何割がファイルに現れたか」（カバレッジ）で採点する。
 *     文書の長さに影響されにくく、なぜその判定になったか説明しやすい。
 *  3. 全科目に共通して出る語（"入門" "演習" "2026" など）は IDF で自動的に軽くなる。
 *  4. 最高点が閾値に届かない、または2位と僅差のときは「わからない」として動かさない。
 */
const { normalize, tokenize, countTokens, stem } = require('./tokenize');

/* ---- チューニング定数（README に説明あり） ---- */
const W_NAME       = 3.0;   // フォルダ名由来トークンの重み
const W_KEYWORD    = 5.0;   // ユーザー指定キーワードの重み
const W_LEARN_NAME = 1.0;   // 学習（ファイル名由来）1回あたりの加算
const W_LEARN_BODY = 0.25;  // 学習（内容由来）1回あたりの加算
const CAP_LEARN    = 6.0;   // 学習重みの上限

// ファイル名と内容は「どちらか一方でも強く一致すれば採用」という合成にする（ソフトOR）。
// 単純な加重平均だと、ファイル名が無関係なだけで内容が完全一致でも点が伸びなかった。
const GAIN_NAME    = 1.00;  // ファイル名一致の効き
const GAIN_BODY    = 0.85;  // 内容一致の効き（名前より少し控えめ）

const BONUS_KEYWORD_IN_NAME = 0.55;  // キーワードがファイル名に丸ごと含まれる
const BONUS_NAME_IN_NAME    = 0.45;  // 科目名がファイル名に丸ごと含まれる
const BONUS_IN_BODY         = 0.20;  // 内容に丸ごと含まれる
const BONUS_CAP             = 0.70;

const MIN_SCORE   = 0.30;   // これ未満なら振り分けない
const MARGIN_ABS  = 0.10;   // 1位と2位の差がこれ未満なら振り分けない
const MARGIN_RATE = 1.35;   // ただし1位が2位のこの倍率以上なら差が小さくても採用

/* ------------------------------------------------------------------ */

/**
 * 科目一覧＋学習データからモデルを組み立てる
 * @param {Array} subjects  store.listSubjects() の結果
 * @param {Array} learned   store.listTokens() の結果
 */
function buildModel(subjects, learned = []) {
  const profiles = new Map();   // subjectId -> Map(token -> weight)
  const literals = new Map();   // subjectId -> [{text, kind}]

  for (const s of subjects) {
    const p = new Map();
    const add = (tok, w) => p.set(tok, (p.get(tok) || 0) + w);

    for (const t of tokenize(s.name)) add(t, W_NAME);
    const kw = (s.keyword || '').trim();
    if (kw) for (const t of tokenize(kw)) add(t, W_KEYWORD);

    profiles.set(s.id, p);

    const lits = [];
    const nName = normalize(s.name);
    if (nName.length >= 2) lits.push({ text: nName, kind: 'name' });
    const nKw = normalize(kw);
    if (nKw.length >= 2) lits.push({ text: nKw, kind: 'keyword' });
    literals.set(s.id, lits);
  }

  for (const row of learned) {
    const p = profiles.get(row.subject_id);
    if (!p) continue;
    const w = Math.min(CAP_LEARN, row.weight);
    p.set(row.token, (p.get(row.token) || 0) + w);
  }

  // IDF：いくつの科目プロフィールに現れる語か
  const N = Math.max(1, subjects.length);
  const df = new Map();
  for (const p of profiles.values()) {
    for (const t of p.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + N / d));

  return { subjects, profiles, literals, idf, N };
}

/** プロフィールの総重量（idf込み）をキャッシュ用に計算 */
function profileMass(profile, idf) {
  let m = 0;
  for (const [t, w] of profile) m += w * (idf.get(t) || 0);
  return m;
}

/**
 * ファイル側のトークン重み Map を作る。
 * 出現回数は sublinear（log）に圧縮し、長文が有利になりすぎないようにする。
 */
function fileVector(text) {
  const counts = countTokens(text);
  const v = new Map();
  for (const [t, c] of counts) v.set(t, 1 + Math.log(c));
  return v;
}

/** カバレッジ：科目プロフィールのうち、ファイルに現れた分の割合（0..1） */
function coverage(profile, idf, vec, mass) {
  if (!mass) return 0;
  let hit = 0;
  for (const [t, w] of profile) {
    const f = vec.get(t);
    if (!f) continue;
    const sat = Math.min(1, f / 2.0);   // 1回出れば0.5、3回程度で満点
    hit += w * (idf.get(t) || 0) * (0.5 + 0.5 * sat);
  }
  return Math.min(1, hit / mass);
}

/** 適合率：ファイル名側の語のうち、その科目に関係する語の割合（0..1） */
function precision(profile, idf, vec) {
  let total = 0, hit = 0;
  for (const [t, f] of vec) {
    const w = f * (idf.get(t) || 0.35);
    total += w;
    if (profile.has(t)) hit += w;
  }
  return total ? hit / total : 0;
}

/**
 * 1ファイルを判定する
 * @param {{fileName:string, content:string}} file
 * @param {object} model buildModel() の戻り値
 * @returns {{matched:boolean, subjectId:string|null, score:number, reason:string, ranking:Array}}
 */
function classify(file, model) {
  const nameRaw = stem(file.fileName || '');
  const bodyRaw = file.content || '';
  const nameNorm = normalize(nameRaw);
  const bodyNorm = normalize(bodyRaw).slice(0, 20000);

  const nameVec = fileVector(nameRaw);
  const bodyVec = bodyRaw ? fileVector(bodyRaw) : new Map();
  const hasBody = bodyVec.size > 0;

  const ranking = [];
  for (const s of model.subjects) {
    const p = model.profiles.get(s.id);
    if (!p || !p.size) continue;
    const mass = profileMass(p, model.idf);

    const covName = coverage(p, model.idf, nameVec, mass);
    const prcName = precision(p, model.idf, nameVec);
    const scoreName = 0.75 * covName + 0.25 * prcName;
    const scoreBody = hasBody ? coverage(p, model.idf, bodyVec, mass) : 0;

    const base = hasBody
      ? 1 - (1 - GAIN_NAME * scoreName) * (1 - GAIN_BODY * scoreBody)
      : scoreName;

    // ルールベースの直接一致ボーナス（科目名やキーワードが丸ごと入っている）
    let bonus = 0;
    const why = [];
    for (const lit of (model.literals.get(s.id) || [])) {
      if (nameNorm.includes(lit.text)) {
        bonus += lit.kind === 'keyword' ? BONUS_KEYWORD_IN_NAME : BONUS_NAME_IN_NAME;
        why.push(`ファイル名に「${lit.text}」`);
      } else if (bodyNorm && bodyNorm.includes(lit.text)) {
        bonus += BONUS_IN_BODY;
        why.push(`内容に「${lit.text}」`);
      }
    }
    bonus = Math.min(BONUS_CAP, bonus);

    ranking.push({
      subjectId: s.id,
      subjectName: s.name,
      score: Math.min(1, base + bonus),
      detail: { covName: +covName.toFixed(3), prcName: +prcName.toFixed(3), covBody: +scoreBody.toFixed(3), bonus: +bonus.toFixed(3) },
      why
    });
  }

  ranking.sort((a, b) => b.score - a.score);
  const best = ranking[0];
  const second = ranking[1];

  if (!best || best.score < MIN_SCORE) {
    return { matched: false, subjectId: null, score: best ? best.score : 0,
             reason: 'low-score', ranking };
  }
  if (second) {
    const diff = best.score - second.score;
    const rate = second.score > 0 ? best.score / second.score : Infinity;
    if (diff < MARGIN_ABS && rate < MARGIN_RATE) {
      return { matched: false, subjectId: null, score: best.score,
               reason: `ambiguous:${best.subjectName}/${second.subjectName}`, ranking };
    }
  }
  return {
    matched: true,
    subjectId: best.subjectId,
    subjectName: best.subjectName,
    score: best.score,
    reason: best.why.length ? best.why.join('、') : `語の一致 ${(best.score * 100) | 0}%`,
    ranking
  };
}

/* ------------------------------------------------------------------ */
/* 学習                                                                */
/* ------------------------------------------------------------------ */

const MAX_BODY_TOKENS = 60;   // 1ファイルから学習する内容トークンの上限

/**
 * 手動で振り分けられたファイルから学習する（sign = -1 で取り消し）
 * @param {object} store
 * @param {string} subjectId
 * @param {{fileName:string, content:string}} file
 * @param {number} sign 1 = 学習、-1 = 取り消し
 */
function learn(store, subjectId, file, sign = 1) {
  const nameTokens = new Set(tokenize(stem(file.fileName || '')));
  for (const t of nameTokens) store.bumpToken(subjectId, t, 'name', W_LEARN_NAME * sign);

  if (file.content) {
    const counts = countTokens(file.content);
    const top = [...counts.entries()]
      .filter(([t]) => t.length >= 2 && !nameTokens.has(t))
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_BODY_TOKENS);
    for (const [t] of top) store.bumpToken(subjectId, t, 'content', W_LEARN_BODY * sign);
  }
}

module.exports = {
  buildModel, classify, learn,
  CONST: { MIN_SCORE, MARGIN_ABS, MARGIN_RATE }
};
