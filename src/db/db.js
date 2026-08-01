/**
 * db.js — ダウンロード自動振り分けアプリ データベース層（ESM）
 * =============================================================================
 * 使い方（Electron メインプロセス側）:
 *
 *   import * as db from './back/db.js';
 *   db.init();                                   // 起動時に1回
 *
 *   // 科目フォルダのルートを指定すれば、フォルダ名から科目を一括登録できる
 *   db.subjects.importFromFolder('D:\\大学\\2026前期');
 *
 *   // 略称の対応表（これが無いと prg1 → 知能情報プログラミング１ は当たらない）
 *   db.aliases.add(subjectId, 'prg1');
 *
 *   const r = db.classify({ fileName:'prg1_202604_w11p_演習.pdf', ext:'pdf', text });
 *   // → { matched:true, source:'alias', subjectId, folderPath, confidence, ... }
 *
 *   db.close();                                  // 終了時
 *
 * 依存: better-sqlite3 のみ（同期API。Electronのメインプロセスで使う想定）
 * =============================================================================
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

import { MIGRATIONS } from './migrations.js';
import * as matcher from './matcher.js';
import * as learner from './learner.js';

export { matcher, learner };

/** @type {import('better-sqlite3').Database|null} */
let db = null;

/* ============================================================================
 * 内部ヘルパー
 * ==========================================================================*/

const toInt = (v) => (v ? 1 : 0);
const nz = (v) => (v === undefined ? null : v);
const nowSql = "datetime('now','localtime')";

/** 先頭トークン（科目略称）は他の語より強い証拠なので重みを増やす */
const HEAD_BOOST = 3;

function assertReady() {
  if (!db) throw new Error('db.init() が呼ばれていません');
}

let _rulesCache = null;
let _aliasCache = null;
let _vocabCache = { filename: null, content: null };
let _stmtUpsertTerm = null;
let _stmtUpsertSubjectStat = null;

const invalidateRules = () => { _rulesCache = null; };
const invalidateAliases = () => { _aliasCache = null; };
const invalidateVocab = () => { _vocabCache = { filename: null, content: null }; };

function defaultDbPath() {
  try {
    const require = createRequire(import.meta.url);
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'filesorter.db');
    }
  } catch { /* Electron外（テスト等） */ }
  return path.join(process.cwd(), 'filesorter.db');
}

/* ============================================================================
 * 初期化 / マイグレーション
 * ==========================================================================*/

export function init(options = {}) {
  if (db) return db;
  const dbPath = options.dbPath || defaultDbPath();
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath, {
    verbose: options.verbose ? console.log : undefined,
    readonly: !!options.readonly,
  });

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  migrate();
  invalidateRules(); invalidateAliases(); invalidateVocab();
  return db;
}

export function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}

export function close() {
  if (db) { db.close(); db = null; }
  _stmtUpsertTerm = null;
  _stmtUpsertSubjectStat = null;
  invalidateRules(); invalidateAliases(); invalidateVocab();
}

export function getDb() { assertReady(); return db; }
export function backup(destPath) { assertReady(); return db.backup(destPath); }
export function vacuum() { assertReady(); db.exec('VACUUM'); return true; }

/* ============================================================================
 * settings — 設定
 * ==========================================================================*/

export const settings = {
  get(key, defaultValue = null) {
    assertReady();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  },
  getNumber(key, defaultValue = 0) {
    const v = settings.get(key, null);
    return v === null || v === '' ? defaultValue : Number(v);
  },
  getBool(key, defaultValue = false) {
    const v = settings.get(key, null);
    return v === null ? defaultValue : (v === '1' || v === 'true');
  },
  getAll() {
    assertReady();
    const out = {};
    for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
    return out;
  },
  set(key, value) {
    assertReady();
    const v = typeof value === 'boolean' ? (value ? '1' : '0')
      : value === null || value === undefined ? null : String(value);
    db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ${nowSql})
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = ${nowSql}`)
      .run(key, v);
    return true;
  },
  setMany(obj) {
    assertReady();
    db.transaction((o) => { for (const [k, v] of Object.entries(o)) settings.set(k, v); })(obj);
    return true;
  },
};

/* ============================================================================
 * subjects — 科目（振り分け先フォルダ）
 * ==========================================================================*/

/** フォルダ名を科目名に分割する。「ICT入門,データサイエンス入門」→ 2科目 */
export function splitFolderName(name) {
  return String(name)
    .split(/[,、，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const subjects = {
  list({ includeDisabled = false } = {}) {
    assertReady();
    return db.prepare(`SELECT * FROM subjects ${includeDisabled ? '' : 'WHERE enabled = 1'}
                       ORDER BY sort_order, id`).all();
  },
  get(id) {
    assertReady();
    return db.prepare('SELECT * FROM subjects WHERE id = ?').get(id) || null;
  },
  getByName(name) {
    assertReady();
    return db.prepare('SELECT * FROM subjects WHERE name = ?').get(name) || null;
  },
  getByFolder(folderPath) {
    assertReady();
    return db.prepare('SELECT * FROM subjects WHERE folder_path = ?').all(folderPath);
  },

  /**
   * @returns {number} 作成された科目ID
   * 科目名そのものは自動的に別名として登録される（「ICT入門」はこれで当たる）
   */
  create({ name, folderPath, color = null, icon = null, sortOrder = null, enabled = true }) {
    assertReady();
    if (!name) throw new Error('name は必須です');
    if (!folderPath) throw new Error('folderPath は必須です');
    const order = sortOrder ?? db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM subjects').get().n;
    const id = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO subjects(name, folder_path, color, icon, sort_order, enabled)
         VALUES(?, ?, ?, ?, ?, ?)`
      ).run(name, folderPath, nz(color), nz(icon), order, toInt(enabled));
      const sid = info.lastInsertRowid;
      insertAlias(sid, name, 'folder', 1.0);
      return sid;
    })();
    invalidateRules(); invalidateAliases();
    return id;
  },

  update(id, patch = {}) {
    assertReady();
    const map = {
      name: 'name', folderPath: 'folder_path', color: 'color', icon: 'icon',
      sortOrder: 'sort_order', enabled: 'enabled',
    };
    const sets = [], vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(col === 'enabled' ? toInt(patch[k]) : nz(patch[k]));
    }
    if (!sets.length) return false;
    sets.push(`updated_at = ${nowSql}`);
    vals.push(id);
    db.prepare(`UPDATE subjects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    invalidateRules(); invalidateAliases();
    return true;
  },

  remove(id) {
    assertReady();
    db.transaction((sid) => {
      db.prepare(`UPDATE history SET subject_name =
                    COALESCE(subject_name, (SELECT name FROM subjects WHERE id = ?))
                  WHERE subject_id = ?`).run(sid, sid);
      db.prepare('DELETE FROM subjects WHERE id = ?').run(sid);
    })(id);
    invalidateRules(); invalidateAliases(); invalidateVocab();
    return true;
  },

  reorder(idsInOrder = []) {
    assertReady();
    const stmt = db.prepare('UPDATE subjects SET sort_order = ? WHERE id = ?');
    db.transaction((ids) => ids.forEach((id, i) => stmt.run(i + 1, id)))(idsInOrder);
    invalidateRules();
    return true;
  },

  /**
   * 指定フォルダ直下のサブフォルダを科目として一括登録する。
   * 「ICT入門,データサイエンス入門」のようなカンマ区切りは複数科目に分割し、
   * 同じフォルダを指すようにする。
   *
   * @param {string} rootPath 例: 'D:\\大学\\2026前期'
   * @returns {{created:Array, skipped:Array, root:string}}
   */
  importFromFolder(rootPath) {
    assertReady();
    if (!rootPath) throw new Error('rootPath は必須です');
    const entries = fs.readdirSync(rootPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'));

    const created = [], skipped = [];
    db.transaction(() => {
      for (const e of entries) {
        const folderPath = path.join(rootPath, e.name);
        const names = splitFolderName(e.name);
        for (const name of names) {
          if (subjects.getByName(name)) { skipped.push({ name, reason: '登録済み' }); continue; }
          const sid = subjects.create({ name, folderPath });
          // フォルダ名そのものも別名にする（分割前の「ICT入門,データサイエンス入門」）
          if (names.length > 1) insertAlias(sid, e.name, 'folder', 0.5);
          created.push({ id: sid, name, folderPath });
        }
      }
    })();
    settings.set('subject_root', rootPath);
    invalidateAliases();
    return { created, skipped, root: rootPath };
  },
};

/* ============================================================================
 * aliases — 科目の別名・略称
 * ==========================================================================*/

function insertAlias(subjectId, alias, origin = 'manual', weight = 1.0) {
  const a = learner.normalizeSubjectKey(alias);
  if (!a || a.length < 2) return null;
  const info = db.prepare(
    `INSERT INTO subject_aliases(subject_id, alias, origin, weight)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(subject_id, alias) DO UPDATE SET weight = MAX(weight, excluded.weight)`
  ).run(subjectId, a, origin, weight);
  return info.lastInsertRowid;
}

export const aliases = {
  add(subjectId, alias, { origin = 'manual', weight = 1.0 } = {}) {
    assertReady();
    const id = insertAlias(subjectId, alias, origin, weight);
    invalidateAliases();
    return id;
  },
  addMany(subjectId, list = [], opts = {}) {
    assertReady();
    db.transaction(() => { for (const a of list) insertAlias(subjectId, a, opts.origin ?? 'manual', opts.weight ?? 1.0); })();
    invalidateAliases();
    return true;
  },
  list(subjectId = null) {
    assertReady();
    const sql = `SELECT a.*, s.name AS subject_name FROM subject_aliases a
                 JOIN subjects s ON s.id = a.subject_id
                 ${subjectId != null ? 'WHERE a.subject_id = ?' : ''}
                 ORDER BY a.subject_id, LENGTH(a.alias) DESC`;
    return subjectId != null ? db.prepare(sql).all(subjectId) : db.prepare(sql).all();
  },
  remove(id) {
    assertReady();
    db.prepare('DELETE FROM subject_aliases WHERE id = ?').run(id);
    invalidateAliases();
    return true;
  },

  /** 判定用（キャッシュ付き）。有効な科目の別名のみ */
  getActive() {
    assertReady();
    if (_aliasCache) return _aliasCache;
    _aliasCache = db.prepare(
      `SELECT a.id, a.subject_id, a.alias, a.weight, s.name AS subject_name, s.folder_path
       FROM subject_aliases a JOIN subjects s ON s.id = a.subject_id
       WHERE s.enabled = 1
       ORDER BY LENGTH(a.alias) DESC`
    ).all();
    return _aliasCache;
  },

  /**
   * ファイル名・本文から別名で科目を特定する。
   *
   * 実PDFの調査で分かったこと:
   *   授業スライドは全ページのフッターに科目名が入っている（PowerPointのマスター）。
   *   一方で他科目の名前も本文に出てくる（「次回よりデータサイエンス入門が始まります」）。
   *   → 「含まれるか」ではなく「何回出てくるか」で判定しないと誤爆する。
   *      ICT入門の資料: ICT入門=15回 / データサイエンス入門=3回
   *
   * スコア = 別名の長さ × 重み × 係数
   *   先頭一致 ×3 ／ ファイル名の部分一致 ×2 ／ 本文の出現回数（最大10）
   *
   * @returns {{subjectId, subjectName, folderPath, alias, where, score, occurrences}|null}
   */
  match({ fileName, text = null }) {
    assertReady();
    const rows = aliases.getActive();
    if (!rows.length) return null;

    const nameKey = learner.normalizeSubjectKey(learner.stripExt(fileName || ''));
    const textKey = text ? learner.normalizeSubjectKey(String(text).slice(0, 20000)) : '';

    const perSubject = new Map();
    for (const r of rows) {
      const a = r.alias;
      if (!a) continue;

      let score = 0, where = null;
      if (nameKey && nameKey.startsWith(a)) { score = a.length * r.weight * 3; where = 'filename_head'; }
      else if (nameKey && nameKey.includes(a)) { score = a.length * r.weight * 2; where = 'filename'; }

      const occ = textKey ? learner.countOccurrences(textKey, a) : 0;
      if (occ > 0) {
        const contentScore = a.length * r.weight * Math.min(occ, 10);
        if (contentScore > score) { score = contentScore; where = 'content'; }
      }
      if (!score) continue;

      const cand = {
        subjectId: r.subject_id, subjectName: r.subject_name, folderPath: r.folder_path,
        alias: a, where, score, occurrences: occ, aliasId: r.id,
      };
      const cur = perSubject.get(r.subject_id);
      if (!cur || score > cur.score) perSubject.set(r.subject_id, cand);
    }

    let best = null;
    for (const c of perSubject.values()) if (!best || c.score > best.score) best = c;
    return best;
  },

  recordHit(id) {
    assertReady();
    db.prepare('UPDATE subject_aliases SET hit_count = hit_count + 1 WHERE id = ?').run(id);
    return true;
  },
};

/* ============================================================================
 * rules — 振り分けルール
 * ==========================================================================*/

function attachConditions(ruleRows) {
  if (ruleRows.length === 0) return ruleRows;
  const ids = ruleRows.map((r) => r.id);
  const rows = db.prepare(
    `SELECT * FROM rule_conditions WHERE rule_id IN (${ids.map(() => '?').join(',')})
     ORDER BY rule_id, sort_order, id`
  ).all(...ids);
  const byRule = new Map();
  for (const c of rows) {
    if (!byRule.has(c.rule_id)) byRule.set(c.rule_id, []);
    byRule.get(c.rule_id).push(c);
  }
  for (const r of ruleRows) r.conditions = byRule.get(r.id) || [];
  return ruleRows;
}

function insertConditions(ruleId, conditions = []) {
  const stmt = db.prepare(
    `INSERT INTO rule_conditions(rule_id, target, operator, value, case_sensitive, sort_order)
     VALUES(?, ?, ?, ?, ?, ?)`
  );
  conditions.forEach((c, i) => {
    stmt.run(ruleId, c.target, c.operator || 'contains', String(c.value),
      toInt(c.caseSensitive ?? c.case_sensitive), c.sortOrder ?? i);
  });
}

export const rules = {
  get(id) {
    assertReady();
    const r = db.prepare('SELECT * FROM v_rules_full WHERE id = ?').get(id);
    return r ? attachConditions([r])[0] : null;
  },
  list({ subjectId = null, includeDisabled = true, origin = null } = {}) {
    assertReady();
    const where = [], vals = [];
    if (subjectId != null) { where.push('subject_id = ?'); vals.push(subjectId); }
    if (!includeDisabled) where.push('enabled = 1');
    if (origin) { where.push('origin = ?'); vals.push(origin); }
    return attachConditions(db.prepare(
      `SELECT * FROM v_rules_full ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY priority DESC, id`).all(...vals));
  },
  getActive() {
    assertReady();
    if (_rulesCache) return _rulesCache;
    _rulesCache = attachConditions(db.prepare(
      `SELECT * FROM v_rules_full WHERE enabled = 1 AND subject_enabled = 1
       ORDER BY priority DESC, id`).all());
    return _rulesCache;
  },
  create(p) {
    assertReady();
    if (!p?.subjectId) throw new Error('subjectId は必須です');
    if (!Array.isArray(p.conditions) || p.conditions.length === 0) {
      throw new Error('conditions を1件以上指定してください');
    }
    const id = db.transaction((params) => {
      const info = db.prepare(
        `INSERT INTO rules(subject_id, name, description, match_mode, priority, enabled,
                           subfolder, origin, confidence)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        params.subjectId, params.name || '無題のルール', nz(params.description),
        params.matchMode || 'all', params.priority ?? 100, toInt(params.enabled ?? true),
        nz(params.subfolder), params.origin || 'user', params.confidence ?? 1.0
      );
      insertConditions(info.lastInsertRowid, params.conditions);
      return info.lastInsertRowid;
    })(p);
    invalidateRules();
    return id;
  },
  update(id, patch = {}) {
    assertReady();
    const map = {
      subjectId: 'subject_id', name: 'name', description: 'description',
      matchMode: 'match_mode', priority: 'priority', enabled: 'enabled',
      subfolder: 'subfolder', origin: 'origin', confidence: 'confidence',
    };
    db.transaction(() => {
      const sets = [], vals = [];
      for (const [k, col] of Object.entries(map)) {
        if (patch[k] === undefined) continue;
        sets.push(`${col} = ?`);
        vals.push(col === 'enabled' ? toInt(patch[k]) : nz(patch[k]));
      }
      if (sets.length) {
        sets.push(`updated_at = ${nowSql}`);
        vals.push(id);
        db.prepare(`UPDATE rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      if (Array.isArray(patch.conditions)) {
        db.prepare('DELETE FROM rule_conditions WHERE rule_id = ?').run(id);
        insertConditions(id, patch.conditions);
      }
    })();
    invalidateRules();
    return true;
  },
  setEnabled(id, enabled) { return rules.update(id, { enabled }); },
  remove(id) {
    assertReady();
    db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    invalidateRules();
    return true;
  },
  recordHit(id) {
    assertReady();
    db.prepare(`UPDATE rules SET hit_count = hit_count + 1, last_matched_at = ${nowSql} WHERE id = ?`).run(id);
    if (_rulesCache) {
      const r = _rulesCache.find((x) => x.id === id);
      if (r) r.hit_count += 1;
    }
    return true;
  },
};

/* ============================================================================
 * content_cache / queue / history
 * ==========================================================================*/

export const content = {
  get(fileHash) {
    assertReady();
    if (!fileHash) return null;
    return db.prepare('SELECT * FROM content_cache WHERE file_hash = ?').get(fileHash) || null;
  },
  put({ fileHash, text, extractor = null, truncated = false }) {
    assertReady();
    if (!fileHash) return false;
    const t = text == null ? null : String(text);
    db.prepare(
      `INSERT INTO content_cache(file_hash, text, char_count, extractor, truncated, extracted_at)
       VALUES(?, ?, ?, ?, ?, ${nowSql})
       ON CONFLICT(file_hash) DO UPDATE SET
         text = excluded.text, char_count = excluded.char_count,
         extractor = excluded.extractor, truncated = excluded.truncated,
         extracted_at = ${nowSql}`
    ).run(fileHash, t, t ? t.length : 0, nz(extractor), toInt(truncated));
    return true;
  },
  purgeOlderThan(days = 90) {
    assertReady();
    return db.prepare(`DELETE FROM content_cache WHERE extracted_at < datetime('now','localtime', ?)`)
      .run(`-${Number(days)} days`).changes;
  },
  count() { assertReady(); return db.prepare('SELECT COUNT(*) AS n FROM content_cache').get().n; },
};

export const queue = {
  add({ sourcePath, fileName = null, ext = null, sizeBytes = null, fileHash = null, status = 'pending' }) {
    assertReady();
    const name = fileName || path.basename(sourcePath);
    const e = ext ?? (path.extname(name).replace(/^\./, '').toLowerCase() || null);
    db.prepare(
      `INSERT INTO queue(source_path, file_name, ext, size_bytes, file_hash, status)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_path) DO UPDATE SET
         file_name = excluded.file_name, size_bytes = excluded.size_bytes,
         file_hash = excluded.file_hash, status = excluded.status, updated_at = ${nowSql}`
    ).run(sourcePath, name, e, nz(sizeBytes), nz(fileHash), status);
    return db.prepare('SELECT id FROM queue WHERE source_path = ?').get(sourcePath).id;
  },
  list(status = null, limit = 200) {
    assertReady();
    const sql = `SELECT q.*, s.name AS subject_name, s.folder_path AS subject_folder
                 FROM queue q LEFT JOIN subjects s ON s.id = q.matched_subject_id
                 ${status ? 'WHERE q.status = ?' : ''}
                 ORDER BY q.detected_at, q.id LIMIT ?`;
    return status ? db.prepare(sql).all(status, limit) : db.prepare(sql).all(limit);
  },
  get(id) { assertReady(); return db.prepare('SELECT * FROM queue WHERE id = ?').get(id) || null; },
  setStatus(id, status, patch = {}) {
    assertReady();
    db.prepare(
      `UPDATE queue SET status = ?, matched_rule_id = COALESCE(?, matched_rule_id),
        matched_subject_id = COALESCE(?, matched_subject_id),
        suggested_json = COALESCE(?, suggested_json), score = COALESCE(?, score),
        error_message = ?, updated_at = ${nowSql}
       WHERE id = ?`
    ).run(status, nz(patch.ruleId), nz(patch.subjectId),
      patch.suggested ? JSON.stringify(patch.suggested) : null,
      nz(patch.score), nz(patch.errorMessage), id);
    return true;
  },
  remove(id) { assertReady(); db.prepare('DELETE FROM queue WHERE id = ?').run(id); return true; },
  removeByPath(p) { assertReady(); db.prepare('DELETE FROM queue WHERE source_path = ?').run(p); return true; },
  clearDone() { assertReady(); return db.prepare("DELETE FROM queue WHERE status = 'done'").run().changes; },
  countByStatus() {
    assertReady();
    const out = {};
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM queue GROUP BY status').all()) out[r.status] = r.n;
    return out;
  },
};

export const history = {
  add(p) {
    assertReady();
    const subject = p.subjectId ? subjects.get(p.subjectId) : null;
    const rule = p.ruleId ? db.prepare('SELECT name FROM rules WHERE id = ?').get(p.ruleId) : null;
    const info = db.prepare(
      `INSERT INTO history(file_name, source_path, dest_path, ext, size_bytes, file_hash,
                           subject_id, subject_name, rule_id, rule_name,
                           action, status, matched_by, score, error_message)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      p.fileName, p.sourcePath, nz(p.destPath), nz(p.ext), nz(p.sizeBytes), nz(p.fileHash),
      nz(p.subjectId), subject ? subject.name : null,
      nz(p.ruleId), rule ? rule.name : null,
      p.action || 'move', p.status || 'success',
      nz(p.matchedBy), nz(p.score), nz(p.errorMessage)
    );
    if (p.ruleId && (p.status || 'success') === 'success') rules.recordHit(p.ruleId);
    return info.lastInsertRowid;
  },
  list({ limit = 100, offset = 0, subjectId = null, status = null, keyword = null, days = null } = {}) {
    assertReady();
    const where = [], vals = [];
    if (subjectId != null) { where.push('subject_id = ?'); vals.push(subjectId); }
    if (status) { where.push('status = ?'); vals.push(status); }
    if (keyword) { where.push('file_name LIKE ?'); vals.push(`%${keyword}%`); }
    if (days) { where.push(`moved_at >= datetime('now','localtime', ?)`); vals.push(`-${Number(days)} days`); }
    return db.prepare(
      `SELECT * FROM v_history_full ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY moved_at DESC, id DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset);
  },
  get(id) { assertReady(); return db.prepare('SELECT * FROM v_history_full WHERE id = ?').get(id) || null; },
  markUndone(id) {
    assertReady();
    db.prepare("UPDATE history SET status = 'undone' WHERE id = ?").run(id);
    return true;
  },
  findByHash(fileHash) {
    assertReady();
    if (!fileHash) return null;
    return db.prepare(`SELECT * FROM history WHERE file_hash = ? AND status = 'success'
                       ORDER BY moved_at DESC LIMIT 1`).get(fileHash) || null;
  },
  stats(days = 30) {
    assertReady();
    const since = `-${Number(days)} days`;
    const one = (sql) => db.prepare(sql).get(since).n;
    return {
      days,
      total: one(`SELECT COUNT(*) AS n FROM history WHERE moved_at >= datetime('now','localtime', ?)`),
      success: one(`SELECT COUNT(*) AS n FROM history WHERE status='success' AND moved_at >= datetime('now','localtime', ?)`),
      failed: one(`SELECT COUNT(*) AS n FROM history WHERE status='failed' AND moved_at >= datetime('now','localtime', ?)`),
      bySubject: db.prepare(
        `SELECT COALESCE(s.name, h.subject_name, '未分類') AS subject, COUNT(*) AS n
         FROM history h LEFT JOIN subjects s ON s.id = h.subject_id
         WHERE h.moved_at >= datetime('now','localtime', ?) AND h.status = 'success'
         GROUP BY subject ORDER BY n DESC`).all(since),
      byDay: db.prepare(
        `SELECT date(moved_at) AS day, COUNT(*) AS n FROM history
         WHERE moved_at >= datetime('now','localtime', ?) GROUP BY day ORDER BY day`).all(since),
      byMatchedBy: db.prepare(
        `SELECT COALESCE(matched_by,'unknown') AS matched_by, COUNT(*) AS n FROM history
         WHERE moved_at >= datetime('now','localtime', ?) AND status='success'
         GROUP BY matched_by ORDER BY n DESC`).all(since),
    };
  },
  purgeOlderThan(days) {
    assertReady();
    const d = days ?? settings.getNumber('history_retention_days', 365);
    return db.prepare(`DELETE FROM history WHERE moved_at < datetime('now','localtime', ?)`)
      .run(`-${Number(d)} days`).changes;
  },
};

/* ============================================================================
 * learn — 手動配置による自動学習
 * ==========================================================================*/

function vocabSize(target) {
  if (_vocabCache[target] != null) return _vocabCache[target];
  const n = db.prepare('SELECT COUNT(DISTINCT term) AS n FROM term_stats WHERE target = ?').get(target).n;
  _vocabCache[target] = n;
  return n;
}

function fetchTermCounts(target, tokens) {
  const map = new Map();
  if (!tokens.length) return map;
  const CHUNK = 400;
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const part = tokens.slice(i, i + CHUNK);
    const rows = db.prepare(
      `SELECT term, subject_id, count FROM term_stats
       WHERE target = ? AND term IN (${part.map(() => '?').join(',')})`).all(target, ...part);
    for (const r of rows) {
      if (!map.has(r.term)) map.set(r.term, new Map());
      map.get(r.term).set(r.subject_id, r.count);
    }
  }
  return map;
}

function fetchSubjectTotals(target) {
  const map = new Map();
  for (const r of db.prepare(
    `SELECT ss.subject_id, ss.sample_count, ss.term_total
     FROM subject_stats ss JOIN subjects s ON s.id = ss.subject_id
     WHERE ss.target = ? AND s.enabled = 1`).all(target)) {
    map.set(r.subject_id, { sampleCount: r.sample_count, termTotal: r.term_total });
  }
  return map;
}

function upsertTermStmt() {
  if (!_stmtUpsertTerm) {
    _stmtUpsertTerm = db.prepare(
      `INSERT INTO term_stats(term, target, subject_id, count, updated_at)
       VALUES(?, ?, ?, ?, ${nowSql})
       ON CONFLICT(term, target, subject_id)
       DO UPDATE SET count = count + excluded.count, updated_at = ${nowSql}`);
  }
  return _stmtUpsertTerm;
}
function upsertSubjectStatStmt() {
  if (!_stmtUpsertSubjectStat) {
    _stmtUpsertSubjectStat = db.prepare(
      `INSERT INTO subject_stats(subject_id, target, sample_count, term_total)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(subject_id, target)
       DO UPDATE SET sample_count = sample_count + excluded.sample_count,
                     term_total   = term_total   + excluded.term_total`);
  }
  return _stmtUpsertSubjectStat;
}

/** 1サンプル分を term_stats に反映（トランザクション内で呼ぶこと） */
function applySample({ subjectId, fileName, text, weight = 1.0, sign = 1 }) {
  const upTerm = upsertTermStmt();
  const upStat = upsertSubjectStatStmt();

  const parsed = learner.parseFileName(fileName || '');
  const contentTokens = learner.tokenize(text, { maxTerms: 400 });

  // --- ファイル名 ---
  if (parsed.tokens.length) {
    let total = 0;
    for (const t of parsed.tokens) {
      // 先頭トークン（科目略称）は重みを増やす
      const w = (t === parsed.head || t === parsed.headStem) ? weight * HEAD_BOOST : weight;
      upTerm.run(t, 'filename', subjectId, w * sign);
      total += w;
    }
    upStat.run(subjectId, 'filename', weight * sign, total * sign);
  }

  // --- 本文 ---
  if (contentTokens.length) {
    for (const t of contentTokens) upTerm.run(t, 'content', subjectId, weight * sign);
    upStat.run(subjectId, 'content', weight * sign, contentTokens.length * weight * sign);
  }
}

export const learn = {
  /**
   * ユーザーが手でファイルを科目フォルダに入れた（または判定を修正した）ことを学習する。
   * @returns {number} learning_samples の ID
   */
  record(p) {
    assertReady();
    if (!p?.subjectId || !p?.fileName) throw new Error('subjectId と fileName は必須です');
    const source = p.source || 'manual_move';
    const weight = p.weight ?? (source === 'correction' ? 2.0 : 1.0);
    const excerpt = p.text ? String(p.text).slice(0, 2000) : null;

    const id = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO learning_samples(subject_id, file_name, ext, text_excerpt, file_hash, source, weight, applied)
         VALUES(?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(p.subjectId, p.fileName, nz(p.ext), excerpt, nz(p.fileHash), source, weight);
      applySample({ subjectId: p.subjectId, fileName: p.fileName, text: excerpt, weight, sign: 1 });

      // 先頭トークンは略称の可能性が高いので、別名候補として自動登録する
      if (p.learnAlias !== false) {
        const parsed = learner.parseFileName(p.fileName);
        if (parsed.head && parsed.head.length >= 2) {
          insertAlias(p.subjectId, parsed.head, 'learned', 0.8);
        }
      }
      return info.lastInsertRowid;
    })();
    invalidateVocab(); invalidateAliases();
    return id;
  },

  /**
   * 学習結果からファイルの科目を推定する
   * @returns {Array<{subjectId, subjectName, folderPath, probability, score}>}
   */
  suggest({ fileName, text = null, topK = 3, minKnownTerms = 2, minSubjects = 2 } = {}) {
    assertReady();
    const parsed = learner.parseFileName(fileName || '');
    const fnTokens = parsed.tokens;
    const ctTokens = learner.tokenize(text, { maxTerms: 400 });

    const fnCounts = fnTokens.length ? fetchTermCounts('filename', fnTokens) : new Map();
    const ctCounts = ctTokens.length ? fetchTermCounts('content', ctTokens) : new Map();

    // 学習済みの語がほとんど無いのに推定すると、単に「サンプルが多い科目」が選ばれてしまう
    if (fnCounts.size + ctCounts.size < minKnownTerms) return [];

    const fnTotals = fetchSubjectTotals('filename');
    const ctTotals = fetchSubjectTotals('content');
    const learned = new Set([...fnTotals.keys(), ...ctTotals.keys()]);
    if (learned.size < minSubjects) return [];

    const maps = [];
    if (fnCounts.size) {
      maps.push({
        weight: 1.5, // ファイル名は情報密度が高い
        map: learner.scoreLog({ tokens: fnTokens, termCounts: fnCounts, subjectTotals: fnTotals, vocabSize: vocabSize('filename') }),
      });
    }
    if (ctCounts.size) {
      maps.push({
        weight: 1.0,
        map: learner.scoreLog({ tokens: ctTokens, termCounts: ctCounts, subjectTotals: ctTotals, vocabSize: vocabSize('content') }),
      });
    }
    if (!maps.length) return [];

    const out = [];
    for (const r of learner.softmaxRank(learner.combineLogScores(maps)).slice(0, topK)) {
      const s = subjects.get(r.subjectId);
      if (!s) continue;
      out.push({
        subjectId: r.subjectId, subjectName: s.name, folderPath: s.folder_path,
        probability: r.probability, score: r.score,
      });
    }
    return out;
  },

  distinctiveTerms(subjectId, { target = 'filename', minCount = 2, topN = 8, minRatio = 0.6 } = {}) {
    assertReady();
    const rows = db.prepare(
      `SELECT t.term, t.count,
              (SELECT SUM(t2.count) FROM term_stats t2 WHERE t2.term = t.term AND t2.target = t.target) AS totalCount
       FROM term_stats t
       WHERE t.subject_id = ? AND t.target = ? AND t.count >= ?
       ORDER BY t.count DESC LIMIT 300`).all(subjectId, target, minCount);
    return learner.pickDistinctiveTerms(rows, { minCount, topN, minRatio });
  },

  promoteToRule(subjectId, { target = 'filename', topN = 5, minCount = 3, minRatio = 0.7, priority = 50 } = {}) {
    assertReady();
    const terms = learn.distinctiveTerms(subjectId, { target, minCount, topN, minRatio });
    if (!terms.length) return null;
    const s = subjects.get(subjectId);
    return rules.create({
      subjectId,
      name: `【自動学習】${s ? s.name : ''}`,
      description: `手動配置 ${terms.map((t) => t.term).join(' / ')} から自動生成`,
      matchMode: 'any',
      priority,
      origin: 'learned',
      confidence: terms.reduce((a, t) => a + t.ratio, 0) / terms.length,
      conditions: terms.map((t) => ({
        target: target === 'content' ? 'content' : 'filename',
        operator: 'contains', value: t.term, caseSensitive: false,
      })),
    });
  },

  rebuild() {
    assertReady();
    const n = db.transaction(() => {
      db.prepare('DELETE FROM term_stats').run();
      db.prepare('DELETE FROM subject_stats').run();
      const samples = db.prepare(
        `SELECT ls.* FROM learning_samples ls JOIN subjects s ON s.id = ls.subject_id`).all();
      for (const smp of samples) {
        applySample({
          subjectId: smp.subject_id, fileName: smp.file_name,
          text: smp.text_excerpt, weight: smp.weight, sign: 1,
        });
      }
      db.prepare('UPDATE learning_samples SET applied = 1').run();
      return samples.length;
    })();
    invalidateVocab();
    return n;
  },

  forget(subjectId) {
    assertReady();
    db.transaction(() => {
      db.prepare('DELETE FROM learning_samples WHERE subject_id = ?').run(subjectId);
      db.prepare('DELETE FROM term_stats WHERE subject_id = ?').run(subjectId);
      db.prepare('DELETE FROM subject_stats WHERE subject_id = ?').run(subjectId);
      db.prepare("DELETE FROM subject_aliases WHERE subject_id = ? AND origin = 'learned'").run(subjectId);
    })();
    invalidateVocab(); invalidateAliases();
    return true;
  },

  stats() {
    assertReady();
    return {
      totalSamples: db.prepare('SELECT COUNT(*) AS n FROM learning_samples').get().n,
      vocabFilename: vocabSize('filename'),
      vocabContent: vocabSize('content'),
      perSubject: db.prepare(
        `SELECT s.id AS subject_id, s.name,
                (SELECT COUNT(*) FROM learning_samples ls WHERE ls.subject_id = s.id) AS samples,
                (SELECT COUNT(*) FROM term_stats t WHERE t.subject_id = s.id) AS terms,
                (SELECT COUNT(*) FROM subject_aliases a WHERE a.subject_id = s.id) AS aliases
         FROM subjects s ORDER BY s.sort_order, s.id`).all(),
    };
  },

  samples({ subjectId = null, limit = 100 } = {}) {
    assertReady();
    const sql = `SELECT ls.*, s.name AS subject_name FROM learning_samples ls
                 LEFT JOIN subjects s ON s.id = ls.subject_id
                 ${subjectId != null ? 'WHERE ls.subject_id = ?' : ''}
                 ORDER BY ls.created_at DESC, ls.id DESC LIMIT ?`;
    return subjectId != null ? db.prepare(sql).all(subjectId, limit) : db.prepare(sql).all(limit);
  },
};

/* ============================================================================
 * classify — ルール → 別名 → 学習 の3段判定
 * ==========================================================================*/

const EMPTY_RESULT = {
  matched: false, source: null, subjectId: null, subjectName: null,
  folderPath: null, subfolder: null, ruleId: null, aliasId: null,
  matchedBy: null, confidence: 0, week: null, date: null, suggestions: [],
};

/**
 * ファイル1件の振り分け先を決める。振り分け処理担当はこれを呼べばよい。
 *
 * @param {{fileName:string, ext?:string, sizeBytes?:number, text?:string}} file
 * @param {{useAliases?:boolean, useLearning?:boolean, minConfidence?:number}} [opts]
 */
export function classify(file, opts = {}) {
  assertReady();
  const useAliases = opts.useAliases ?? true;
  const useLearning = opts.useLearning ?? settings.getBool('learning_enabled', true);
  const minConfidence = opts.minConfidence ?? settings.getNumber('learning_min_confidence', 0.6);

  const parsed = learner.parseFileName(file.fileName || '');
  const base = { ...EMPTY_RESULT, week: parsed.week, date: parsed.date };

  // 1) 明示的なルール（決定的・最優先）
  const r = matcher.classify(rules.getActive(), file);
  if (r.matched) {
    const s = subjects.get(r.subjectId);
    return {
      ...base, matched: true, source: 'rule',
      subjectId: r.subjectId, subjectName: s ? s.name : null,
      folderPath: s ? s.folder_path : null, subfolder: r.rule.subfolder || null,
      ruleId: r.rule.id, matchedBy: r.matchedBy, confidence: r.rule.confidence ?? 1.0,
    };
  }

  // 2) 別名・略称（prg1 → 知能情報プログラミング１）
  if (useAliases) {
    const a = aliases.match({ fileName: file.fileName, text: file.text });
    if (a) {
      return {
        ...base, matched: true, source: 'alias',
        subjectId: a.subjectId, subjectName: a.subjectName, folderPath: a.folderPath,
        aliasId: a.aliasId, matchedBy: a.where === 'content' ? 'content' : 'filename',
        // 本文はフッターに繰り返し出るほど信頼できる（他科目への言及は数回で終わる）
        confidence: a.where === 'filename_head' ? 0.95
          : a.where === 'filename' ? 0.85
            : a.occurrences >= 3 ? 0.9 : 0.7,
        alias: a.alias, occurrences: a.occurrences,
      };
    }
  }

  // 3) 手動配置の学習による推定
  if (!useLearning) return base;
  const suggestions = learn.suggest({ fileName: file.fileName, text: file.text, topK: 3 });
  if (!suggestions.length) return base;

  const top = suggestions[0];
  if (top.probability < minConfidence) return { ...base, suggestions };

  return {
    ...base, matched: true, source: 'learning',
    subjectId: top.subjectId, subjectName: top.subjectName, folderPath: top.folderPath,
    matchedBy: file.text ? 'both' : 'filename', confidence: top.probability, suggestions,
  };
}

/* ============================================================================
 * メンテナンス
 * ==========================================================================*/

export function maintenance() {
  assertReady();
  const removedHistory = history.purgeOlderThan();
  const removedCache = content.purgeOlderThan(90);
  queue.clearDone();
  return { removedHistory, removedCache };
}

export default {
  init, close, getDb, migrate, backup, vacuum, maintenance,
  settings, subjects, aliases, rules, content, queue, history, learn,
  classify, splitFolderName, matcher, learner,
};
