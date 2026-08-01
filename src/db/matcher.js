'use strict';
/**
 * matcher.js — ルール判定エンジン（DBに保存されたルールをファイルに適用する）
 * -----------------------------------------------------------------------------
 * 外部依存なし。db.js から呼ばれるほか、単体テストも可能。
 *
 * file オブジェクト:
 *   {
 *     fileName:   'ベクトル解析_第3回課題.pdf',
 *     ext:        'pdf',            // ドット無し（あっても可）
 *     sizeBytes:  123456,
 *     text:       'PDFやWordから抽出した本文（無ければ null）'
 *   }
 */

/** 大文字小文字の正規化 */
function norm(v, caseSensitive) {
  const s = v == null ? '' : String(v);
  return caseSensitive ? s : s.toLowerCase();
}

/** 拡張子を 'pdf' 形式に揃える */
function cleanExt(ext) {
  return String(ext || '').replace(/^\./, '').toLowerCase();
}

/**
 * 条件1件を評価する
 * @returns {boolean}
 */
function testCondition(cond, file) {
  const cs = !!cond.case_sensitive;

  // --- サイズ比較は数値扱い ---
  if (cond.target === 'size') {
    const n = Number(file.sizeBytes ?? 0);
    const v = Number(cond.value);
    if (Number.isNaN(v)) return false;
    if (cond.operator === 'gt') return n > v;
    if (cond.operator === 'lt') return n < v;
    if (cond.operator === 'equals') return n === v;
    return false;
  }

  // --- 文字列比較 ---
  let raw;
  switch (cond.target) {
    case 'filename':  raw = file.fileName || ''; break;
    case 'extension': {
      const fromName = /\.([^.\\/]+)$/.exec(file.fileName || '');
      raw = cleanExt(file.ext || (fromName ? fromName[1] : ''));
      break;
    }
    case 'content':   raw = file.text || ''; break;
    case 'any_text':  raw = `${file.fileName || ''}\n${file.text || ''}`; break;
    default: return false;
  }

  const hay = norm(raw, cs);
  const needle = norm(cond.value, cs);

  switch (cond.operator) {
    case 'contains':     return hay.includes(needle);
    case 'not_contains': return !hay.includes(needle);
    case 'equals':       return hay === needle;
    case 'starts_with':  return hay.startsWith(needle);
    case 'ends_with':    return hay.endsWith(needle);
    case 'in':
      return needle.split(',').map((s) => s.trim()).filter(Boolean).includes(hay);
    case 'regex':
      try {
        return new RegExp(cond.value, cs ? 'u' : 'iu').test(raw);
      } catch (e) {
        return false; // 不正な正規表現は「不一致」扱い（落とさない）
      }
    default:
      return false;
  }
}

/**
 * ルール1件を評価する
 * @param {object} rule  conditions 配列を持つルール
 * @returns {{matched:boolean, hitCount:number, targets:string[], details:Array}}
 */
function evaluateRule(rule, file) {
  const conds = rule.conditions || [];
  if (conds.length === 0) return { matched: false, hitCount: 0, targets: [], details: [] };

  const details = conds.map((c) => ({ condition: c, ok: testCondition(c, file) }));
  const hits = details.filter((d) => d.ok);
  const matched = rule.match_mode === 'any'
    ? hits.length > 0
    : hits.length === conds.length;

  const targets = [...new Set(hits.map((d) => d.condition.target))];
  return { matched, hitCount: hits.length, targets, details };
}

/** ヒットした条件の種類から「何で当たったか」を作る */
function matchedByLabel(targets) {
  const byName = targets.includes('filename') || targets.includes('extension');
  const byContent = targets.includes('content');
  const byAny = targets.includes('any_text');
  if (byAny) return 'both';
  if (byName && byContent) return 'both';
  if (byContent) return 'content';
  if (byName) return 'filename';
  return 'other';
}

/**
 * ルール群からファイルの振り分け先を決める
 * 優先順: priority 降順 → ヒット条件数 降順 → id 昇順
 *
 * @param {Array} rules  conditions 付きの有効ルール配列
 * @param {object} file
 * @returns {{
 *   matched: boolean, rule: object|null, subjectId: number|null,
 *   matchedBy: string|null, hitCount: number, allMatches: Array
 * }}
 */
function classify(rules, file) {
  const results = [];
  for (const rule of rules) {
    if (rule.enabled === 0) continue;
    const r = evaluateRule(rule, file);
    if (r.matched) {
      results.push({
        rule,
        subjectId: rule.subject_id,
        hitCount: r.hitCount,
        matchedBy: matchedByLabel(r.targets),
        targets: r.targets,
      });
    }
  }

  results.sort((a, b) =>
    (b.rule.priority - a.rule.priority) ||
    (b.hitCount - a.hitCount) ||
    (a.rule.id - b.rule.id));

  const best = results[0] || null;
  return {
    matched: !!best,
    rule: best ? best.rule : null,
    subjectId: best ? best.subjectId : null,
    matchedBy: best ? best.matchedBy : null,
    hitCount: best ? best.hitCount : 0,
    allMatches: results,
  };
}

module.exports = { testCondition, evaluateRule, classify, matchedByLabel, cleanExt };
