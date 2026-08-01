/**
 * matcher.js — ルール判定エンジン（DBに保存されたルールをファイルに適用する）
 * =============================================================================
 * 外部依存なし。db.js から呼ばれるほか、単体テストも可能。
 *
 * file オブジェクト:
 *   {
 *     fileName:   'ICT入門⑧.pdf',
 *     ext:        'pdf',            // ドット無し（あっても可）
 *     sizeBytes:  123456,
 *     text:       'PDFやWordから抽出した本文（無ければ null）'
 *   }
 *
 * 比較は全て NFKC 正規化してから行う。これにより
 *   ⑧ = 8 ／ １ = 1 ／ Ａ = A ／ ｱ = ア
 * が同一視される。「イングリッシュトピックス１」と「…1」を取りこぼさないため。
 */

/** NFKC正規化（+ 必要なら小文字化） */
function norm(v, caseSensitive) {
  const s = v == null ? '' : String(v).normalize('NFKC');
  return caseSensitive ? s : s.toLowerCase();
}

/** 拡張子を 'pdf' 形式に揃える */
export function cleanExt(ext) {
  return String(ext || '').replace(/^\./, '').normalize('NFKC').toLowerCase();
}

/**
 * 条件1件を評価する
 * @returns {boolean}
 */
export function testCondition(cond, file) {
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
    case 'filename': raw = file.fileName || ''; break;
    case 'extension': {
      const fromName = /\.([^.\\/]+)$/.exec(file.fileName || '');
      raw = cleanExt(file.ext || (fromName ? fromName[1] : ''));
      break;
    }
    case 'content': raw = file.text || ''; break;
    case 'any_text': raw = `${file.fileName || ''}\n${file.text || ''}`; break;
    default: return false;
  }

  const hay = norm(raw, cs);
  const needle = norm(cond.value, cs);

  switch (cond.operator) {
    case 'contains': return hay.includes(needle);
    case 'not_contains': return !hay.includes(needle);
    case 'equals': return hay === needle;
    case 'starts_with': return hay.startsWith(needle);
    case 'ends_with': return hay.endsWith(needle);
    case 'in':
      return needle.split(',').map((s) => s.trim()).filter(Boolean).includes(hay);
    case 'regex':
      try {
        // 正規表現も正規化後の文字列に対して適用する（⑧ を 8 として書ける）
        return new RegExp(cond.value.normalize('NFKC'), cs ? 'u' : 'iu').test(hay);
      } catch {
        return false; // 不正な正規表現は「不一致」扱い（アプリを落とさない）
      }
    default:
      return false;
  }
}

/**
 * ルール1件を評価する
 * @returns {{matched:boolean, hitCount:number, targets:string[], details:Array}}
 */
export function evaluateRule(rule, file) {
  const conds = rule.conditions || [];
  if (conds.length === 0) return { matched: false, hitCount: 0, targets: [], details: [] };

  const details = conds.map((c) => ({ condition: c, ok: testCondition(c, file) }));
  const hits = details.filter((d) => d.ok);
  const matched = rule.match_mode === 'any' ? hits.length > 0 : hits.length === conds.length;

  return { matched, hitCount: hits.length, targets: [...new Set(hits.map((d) => d.condition.target))], details };
}

/** ヒットした条件の種類から「何で当たったか」を作る */
export function matchedByLabel(targets) {
  const byName = targets.includes('filename') || targets.includes('extension');
  const byContent = targets.includes('content');
  if (targets.includes('any_text')) return 'both';
  if (byName && byContent) return 'both';
  if (byContent) return 'content';
  if (byName) return 'filename';
  return 'other';
}

/**
 * ルール群からファイルの振り分け先を決める
 * 優先順: priority 降順 → ヒット条件数 降順 → id 昇順
 */
export function classify(rules, file) {
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
