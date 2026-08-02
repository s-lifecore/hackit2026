'use strict';
/**
 * classifier.js — ルールベースの振り分け判定エンジン
 *
 * 基本の考え方
 *  1. 科目ごとに「プロフィール」（重み付きトークン集合）を作る。
 *       - フォルダ名（科目名）        … 重み 3.0
 *       - ユーザーが指定したキーワード … 重み 5.0
 *       - 手動振り分けから学習した語   … 出現に応じて加算
 *  2. ファイル（ファイル名・先頭・本文）のトークンと突き合わせて採点する。
 *  3. 全科目に共通して出る語（"入門" "演習" "2026" など）は IDF で自動的に軽くなる。
 *
 * ★ 誤配置を減らすための方針：点数だけで決めない
 *  点数がそこそこ高いだけでは動かさない。「なぜそう判定したか」を証拠の種類で分け、
 *  次のどれかに当てはまるときだけ移動する。
 *
 *    name-literal … ファイル名に科目名／キーワードがそのまま入っている（最も確実）
 *    name-tokens  … ファイル名の語が科目プロフィールと十分に一致する
 *    head-literal … 文書の先頭に科目名がそのまま出てくる
 *    head-tokens  … 文書の先頭の語が十分に一致する（Word以外。配られる資料）
 *
 *  本文の奥のほうで語がぱらぱら一致しているだけ、という状態では動かさない。
 *  誤配置のほとんどがこのパターンだった。
 *
 * ★ ファイルの種類による差
 *  PDF・PowerPoint は配られる資料で、表紙や1枚目に科目名が載っていることが多い。
 *  そのため内容の一致を信頼する。
 *  一方 Word（.docx）は学生が自分で書くレポートで、科目名を書かないことが多く、
 *  「課題」「考察」「参考文献」のような、どの科目にも出る語ばかりになる。
 *  そこで Word などは内容の語の一致だけでは動かさず、ファイル名か、
 *  文書の先頭に科目名がはっきり出ていることを求める。
 */
const path = require('path');
const { normalize, tokenize, countTokens, stem } = require('./tokenize');

/* ---- チューニング定数（README に説明あり） ---- */
const W_NAME       = 3.0;   // フォルダ名由来トークンの重み
const W_KEYWORD    = 5.0;   // ユーザー指定キーワードの重み
const W_LEARN_NAME = 1.0;   // 学習（ファイル名由来）1回あたりの加算
const W_LEARN_BODY = 0.25;  // 学習（内容由来）1回あたりの加算
const CAP_LEARN    = 6.0;   // 学習重みの上限

/** 文書の「先頭」とみなす文字数。PDFなら表紙〜2ページ目あたりに相当する */
const HEAD_CHARS = 1200;

/**
 * 内容の語の一致だけでは動かさないファイル種別。
 * 本人が書く文書は「課題」「考察」「参考文献」など、どの科目にも出る語ばかりで、
 * 肝心の科目名は書かれていないことが多い。誤配置のほとんどがここだった。
 * これ以外（PDF・PowerPoint など配られる資料）は表紙に科目名が載るので内容を信頼する。
 */
const CONTENT_CAUTIOUS_EXT = new Set(['.docx', '.doc', '.docm', '.odt', '.rtf', '.pages']);

// ファイル名・先頭・本文は「どれかが強く一致すれば採用」という合成にする（ソフトOR）。
// 単純な加重平均だと、ファイル名が無関係なだけで内容が完全一致でも点が伸びなかった。
const GAIN_NAME = 1.00;   // ファイル名一致の効き
const GAIN_HEAD = 0.90;   // 先頭一致の効き
const GAIN_BODY = 0.45;   // 本文の奥の一致。ノイズが多いので弱くする
const GAIN_BODY_UNTRUSTED = 0.20;   // Word など、本人が書く文書の本文はさらに弱く

const BONUS_KEYWORD_IN_NAME = 0.55;  // キーワードがファイル名に丸ごと含まれる
const BONUS_NAME_IN_NAME    = 0.45;  // 科目名がファイル名に丸ごと含まれる
const BONUS_LEAD            = 0.15;  // しかもファイル名の先頭にある（"PD入門_2026_..." など）
const BONUS_IN_HEAD         = 0.22;  // 文書の先頭に丸ごと含まれる
const BONUS_IN_BODY         = 0.08;  // 本文の奥に丸ごと含まれる
const BONUS_CAP             = 0.70;

const MIN_SCORE   = 0.45;   // これ未満なら振り分けない
const MARGIN_ABS  = 0.15;   // 1位と2位の差がこれ未満なら振り分けない
const MARGIN_RATE = 1.50;   // ただし1位が2位のこの倍率以上なら差が小さくても採用

const NAME_STRONG = 0.50;   // ファイル名の語の一致がこれ以上なら確かな証拠とみなす
const HEAD_STRONG = 0.45;   // 文書の先頭の語の一致（配布資料のみ）

/**
 * 学習した語のうち「命名の規則」とみなす最低回数。
 * 1回しか出ていない語（そのファイル固有の題名など）は規則ではなくノイズなので外す。
 * こうしないと、教えるたびに固有の語が増えてしまい、
 * 何度手で振り分けても覚えたことにならない。
 */
const LEARN_REPEAT = 2.0;

/* ------------------------------------------------------------------ */

/**
 * 科目一覧＋学習データからモデルを組み立てる
 * @param {Array} subjects  store.listSubjects() の結果
 * @param {Array} learned   store.listTokens() の結果
 */
function buildModel(subjects, learned = []) {
  const profiles = new Map();       // subjectId -> Map(token -> weight)  すべて
  const nameProfiles = new Map();   // subjectId -> Map(token -> weight)  名前系だけ
  const learnProfiles = new Map();  // subjectId -> Map(token -> weight)  学習したファイル名の語だけ
  const literals = new Map();       // subjectId -> [{text, kind}]

  for (const s of subjects) {
    const p = new Map(), pn = new Map();
    learnProfiles.set(s.id, new Map());
    const add = (map, tok, w) => map.set(tok, (map.get(tok) || 0) + w);

    for (const t of tokenize(s.name)) { add(p, t, W_NAME); add(pn, t, W_NAME); }
    const kw = (s.keyword || '').trim();
    if (kw) for (const t of tokenize(kw)) { add(p, t, W_KEYWORD); add(pn, t, W_KEYWORD); }

    profiles.set(s.id, p);
    nameProfiles.set(s.id, pn);

    const lits = [];
    const nName = normalize(s.name);
    if (nName.length >= 2) lits.push({ text: nName, kind: 'name' });
    const nKw = normalize(kw);
    if (nKw.length >= 2) lits.push({ text: nKw, kind: 'keyword' });
    literals.set(s.id, lits);
  }

  // 学習した語は、由来（ファイル名か内容か）で入れ先を分ける。
  // ファイル名の一致を測るときに、内容から拾った大量の語で薄まらないようにするため。
  // これが混ざっていると、何度手で教えてもファイル名だけでは判定できないままになる。
  for (const row of learned) {
    const p = profiles.get(row.subject_id);
    if (!p) continue;
    const w = Math.min(CAP_LEARN, row.weight);
    p.set(row.token, (p.get(row.token) || 0) + w);
    if (row.field === 'name') {
      const pn = nameProfiles.get(row.subject_id);
      pn.set(row.token, (pn.get(row.token) || 0) + w);
      // 繰り返し出てくる語だけを「命名の規則」として覚える
      if (w >= LEARN_REPEAT) {
        const pl = learnProfiles.get(row.subject_id);
        pl.set(row.token, (pl.get(row.token) || 0) + w);
      }
    }
  }

  // IDF：いくつの科目プロフィールに現れる語か
  const N = Math.max(1, subjects.length);
  const df = new Map();
  for (const p of profiles.values()) {
    for (const t of p.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + N / d));

  return { subjects, profiles, nameProfiles, learnProfiles, literals, idf, N };
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
  if (!mass || !vec.size) return 0;
  let hit = 0;
  for (const [t, w] of profile) {
    const f = vec.get(t);
    if (!f) continue;
    const sat = Math.min(1, f / 2.0);   // 1回出れば0.5、3回程度で満点
    hit += w * (idf.get(t) || 0) * (0.5 + 0.5 * sat);
  }
  return Math.min(1, hit / mass);
}

/**
 * ファイル名向けのカバレッジ。
 * 出現回数による重み付け（同じ語が何度も出るほど強い）をしない。
 * ファイル名は短く、同じ語が繰り返されること自体に意味がないため。
 */
function coverageFlat(profile, idf, vec, mass) {
  if (!mass || !vec.size) return 0;
  let hit = 0;
  for (const [t, w] of profile) if (vec.has(t)) hit += w * (idf.get(t) || 0);
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

/** ファイル名の先頭セグメント（"prg1_202604_w13p_..." なら "prg1"） */
function leadSegment(nameStem) {
  const first = String(nameStem || '').split(/[_\s\-–—[\](){}]+/).filter(Boolean)[0] || '';
  return normalize(first);
}

/** 証拠の種類を日本語にする */
function evidenceLabel(kind, litText) {
  switch (kind) {
    case 'name-literal': return `ファイル名に「${litText}」`;
    case 'name-tokens':  return 'ファイル名の語が一致';
    case 'head-literal': return `先頭ページに「${litText}」`;
    case 'head-tokens':  return '先頭ページの語が一致';
    default: return '';
  }
}

/**
 * 1ファイルを判定する
 * @param {{fileName:string, content:string, ext?:string}} file
 * @param {object} model buildModel() の戻り値
 * @returns {{matched:boolean, subjectId:string|null, score:number, reason:string, ranking:Array}}
 */
function classify(file, model) {
  const nameRaw = stem(file.fileName || '');
  const bodyRaw = file.content || '';
  const headRaw = bodyRaw.slice(0, HEAD_CHARS);

  const nameNorm = normalize(nameRaw);
  const leadNorm = leadSegment(nameRaw);
  const headNorm = normalize(headRaw);
  const bodyNorm = normalize(bodyRaw).slice(0, 20000);

  const ext = (file.ext || path.extname(file.fileName || '')).toLowerCase();
  const trusted = !CONTENT_CAUTIOUS_EXT.has(ext);
  const gainBody = trusted ? GAIN_BODY : GAIN_BODY_UNTRUSTED;

  const nameVec = fileVector(nameRaw);
  const headVec = headRaw ? fileVector(headRaw) : new Map();
  const bodyVec = bodyRaw ? fileVector(bodyRaw) : new Map();
  const hasBody = bodyVec.size > 0;

  const ranking = [];
  for (const s of model.subjects) {
    const p = model.profiles.get(s.id);
    if (!p || !p.size) continue;
    const mass = profileMass(p, model.idf);

    // ファイル名は「名前系プロフィール」と比べる（内容由来の語で薄めない）
    const pn = (model.nameProfiles && model.nameProfiles.get(s.id)) || p;
    const massName = profileMass(pn, model.idf);

    const covName = coverageFlat(pn, model.idf, nameVec, massName);
    const prcName = precision(p, model.idf, nameVec);

    // 過去に手で振り分けたファイル名とどれだけ似ているか。
    // 「prg1_...」のような命名規則を覚えるのはこの経路。
    const pl = (model.learnProfiles && model.learnProfiles.get(s.id)) || null;
    const covLearn = pl && pl.size
      ? coverageFlat(pl, model.idf, nameVec, profileMass(pl, model.idf))
      : 0;

    const scoreName = Math.max(0.75 * covName + 0.25 * prcName, 0.9 * covLearn);
    const covHead = hasBody ? coverage(p, model.idf, headVec, mass) : 0;
    const covBody = hasBody ? coverage(p, model.idf, bodyVec, mass) : 0;

    const scoreContent = hasBody
      ? 1 - (1 - GAIN_HEAD * covHead) * (1 - gainBody * covBody)
      : 0;

    const base = hasBody
      ? 1 - (1 - GAIN_NAME * scoreName) * (1 - scoreContent)
      : scoreName;

    // ルールベースの直接一致（科目名やキーワードが丸ごと入っている）
    let bonus = 0;
    const why = [];
    let litInName = null, litInHead = null;

    for (const lit of (model.literals.get(s.id) || [])) {
      if (nameNorm.includes(lit.text)) {
        bonus += lit.kind === 'keyword' ? BONUS_KEYWORD_IN_NAME : BONUS_NAME_IN_NAME;
        // ファイル名の先頭に置かれているものは、授業資料の命名規則である可能性が高い
        if (leadNorm && leadNorm.includes(lit.text)) bonus += BONUS_LEAD;
        litInName = litInName || lit.text;
        why.push(`ファイル名に「${lit.text}」`);
      } else if (headNorm && headNorm.includes(lit.text)) {
        bonus += BONUS_IN_HEAD;
        litInHead = litInHead || lit.text;
        why.push(`先頭ページに「${lit.text}」`);
      } else if (bodyNorm && bodyNorm.includes(lit.text)) {
        bonus += BONUS_IN_BODY;
        why.push(`内容に「${lit.text}」`);
      }
    }
    bonus = Math.min(BONUS_CAP, bonus);

    // ★ 証拠の種類を決める。これが無いものは点数が高くても動かさない
    let evidence = null, evidenceText = '';
    if (litInName) { evidence = 'name-literal'; evidenceText = litInName; }
    else if (scoreName >= NAME_STRONG) { evidence = 'name-tokens'; }
    else if (litInHead) { evidence = 'head-literal'; evidenceText = litInHead; }
    else if (trusted && covHead >= HEAD_STRONG) { evidence = 'head-tokens'; }

    ranking.push({
      subjectId: s.id,
      subjectName: s.name,
      score: Math.min(1, base + bonus),
      evidence,
      evidenceText,
      detail: {
        covName: +covName.toFixed(3), prcName: +prcName.toFixed(3),
        covHead: +covHead.toFixed(3), covBody: +covBody.toFixed(3),
        bonus: +bonus.toFixed(3), trusted
      },
      why
    });
  }

  ranking.sort((a, b) => b.score - a.score);
  const best = ranking[0];
  const second = ranking[1];

  if (!best) {
    return { matched: false, subjectId: null, score: 0, reason: 'no-subject', ranking };
  }

  // 証拠が無い＝本文でぱらぱら一致しただけ。動かさない
  if (!best.evidence) {
    return {
      matched: false, subjectId: null, score: best.score,
      reason: trusted ? '決め手がない' : '決め手がない（ファイル名か先頭に科目名が必要）',
      ranking
    };
  }
  if (best.score < MIN_SCORE) {
    return { matched: false, subjectId: null, score: best.score, reason: 'low-score', ranking };
  }
  if (second) {
    const diff = best.score - second.score;
    const rate = second.score > 0 ? best.score / second.score : Infinity;
    if (diff < MARGIN_ABS && rate < MARGIN_RATE) {
      return {
        matched: false, subjectId: null, score: best.score,
        reason: `ambiguous:${best.subjectName}/${second.subjectName}`, ranking
      };
    }
  }
  return {
    matched: true,
    subjectId: best.subjectId,
    subjectName: best.subjectName,
    score: best.score,
    evidence: best.evidence,
    reason: best.why.length ? best.why.join('、') : evidenceLabel(best.evidence, best.evidenceText),
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
  CONST: {
    MIN_SCORE, MARGIN_ABS, MARGIN_RATE,
    NAME_STRONG, HEAD_STRONG, HEAD_CHARS, LEARN_REPEAT, CONTENT_CAUTIOUS_EXT
  }
};
