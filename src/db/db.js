'use strict';
/**
 * db.js — ダウンロード自動振り分けアプリ データベース層
 * =============================================================================
 * 使い方（Electron メインプロセス側）:
 *
 *   const db = require('./db');
 *   db.init();                                  // 起動時に1回
 *   const sid = db.subjects.create({ name:'線形代数', folderPath:'D:\\大学\\線形代数' });
 *   db.rules.create({ subjectId: sid, name:'線形代数PDF',
 *     conditions:[ {target:'filename', operator:'contains', value:'線形代数'} ] });
 *
 *   const r = db.classify({ fileName:'線形代数_第3回.pdf', ext:'pdf', text:null });
 *   // → { matched:true, subjectId:1, folderPath:'...', matchedBy:'filename', ... }
 *
 *   db.close();                                 // 終了時
 *
 * 依存: better-sqlite3 のみ（同期API。Electronのメインプロセスで使う想定）
 * =============================================================================
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { MIGRATIONS } = require('./migrations');
const matcher = require('./matcher');
const learner = require('./learner');

/** @type {import('better-sqlite3').Database|null} */
let db = null;

/* ============================================================================
 * 内部ヘルパー
 * ==========================================================================*/

const toInt = (v) => (v ? 1 : 0);
const nz = (v) => (v === undefined ? null : v);
const nowSql = "datetime('now','localtime')";

function assertReady() {
  if (!db) throw new Error('db.init() が呼ばれていません');
}

/** ルールキャッシュ（chokidarから高頻度で呼ばれるため） */
let _rulesCache = null;
let _vocabCache = { filename: null, content: null };
function invalidateRules() { _rulesCache = null; }
function invalidateVocab() { _vocabCache = { filename: null, content: null }; }

function defaultDbPath() {
  try {
    // Electron 環境なら userData 配下へ
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'filesorter.db');
    }
  } catch (_) { /* Electron外（テスト等） */ }
  return path.join(process.cwd(), 'filesorter.db');
}

/* ============================================================================
 * 初期化 / マイグレーション
 * ==========================================================================*/

/**
 * @param {{dbPath?:string, verbose?:boolean, readonly?:boolean}} options
 */
function init(options = {}) {
  if (db) return db;
  const dbPath = options.dbPath || defaultDbPath();
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  db = new Database(dbPath, {
    verbose: options.verbose ? console.log : undefined,
    readonly: !!options.readonly,
  });

  db.pragma('journal_mode = WAL');   // 書き込み中も読める
  db.pragma('foreign_keys = ON');    // ON DELETE CASCADE を効かせる
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  migrate();
  invalidateRules();
  invalidateVocab();
  return db;
}

function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    run();
  }
}

function close() {
  if (db) { db.close(); db = null; }
  _stmtUpsertTerm = null;
  _stmtUpsertSubjectStat = null;
  invalidateRules();
  invalidateVocab();
}

function getDb() { assertReady(); return db; }

/** バックアップ（設定画面の「バックアップ」ボタン用） */
function backup(destPath) {
  assertReady();
  return db.backup(destPath);
}

/* ============================================================================
 * settings — 設定
 * ==========================================================================*/

const settings = {
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
    const tx = db.transaction((o) => { for (const [k, v] of Object.entries(o)) settings.set(k, v); });
    tx(obj);
    return true;
  },
};

/* ============================================================================
 * subjects — 科目（振り分け先フォルダ）
 * ==========================================================================*/

const subjects = {
  list({ includeDisabled = false } = {}) {
    assertReady();
    const sql = `SELECT * FROM subjects ${includeDisabled ? '' : 'WHERE enabled = 1'}
                 ORDER BY sort_order, id`;
    return db.prepare(sql).all();
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
    return db.prepare('SELECT * FROM subjects WHERE folder_path = ?').get(folderPath) || null;
  },
  /** @returns {number} 作成された科目ID */
  create({ name, folderPath, color = null, icon = null, sortOrder = null, enabled = true }) {
    assertReady();
    if (!name) throw new Error('name は必須です');
    if (!folderPath) throw new Error('folderPath は必須です');
    const order = sortOrder ?? (db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM subjects').get().n);
    const info = db.prepare(
      `INSERT INTO subjects(name, folder_path, color, icon, sort_order, enabled)
       VALUES(?, ?, ?, ?, ?, ?)`
    ).run(name, folderPath, nz(color), nz(icon), order, toInt(enabled));
    invalidateRules();
    return info.lastInsertRowid;
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
    invalidateRules();
    return true;
  },
  /** 科目削除。ルール・学習データもCASCADEで消える（履歴は名前が残る） */
  remove(id) {
    assertReady();
    const tx = db.transaction((sid) => {
      db.prepare('UPDATE history SET subject_name = COALESCE(subject_name, (SELECT name FROM subjects WHERE id = ?)) WHERE subject_id = ?').run(sid, sid);
      db.prepare('DELETE FROM subjects WHERE id = ?').run(sid);
    });
    tx(id);
    invalidateRules();
    invalidateVocab();
    return true;
  },
  reorder(idsInOrder = []) {
    assertReady();
    const stmt = db.prepare('UPDATE subjects SET sort_order = ? WHERE id = ?');
    db.transaction((ids) => ids.forEach((id, i) => stmt.run(i + 1, id)))(idsInOrder);
    invalidateRules();
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
    stmt.run(
      ruleId,
      c.target,
      c.operator || 'contains',
      String(c.value),
      toInt(c.caseSensitive ?? c.case_sensitive),
      c.sortOrder ?? i
    );
  });
}

const rules = {
  /** conditions 付きで1件取得 */
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
    const sql = `SELECT * FROM v_rules_full
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY priority DESC, id`;
    return attachConditions(db.prepare(sql).all(...vals));
  },
  /** 判定に使う有効ルール（キャッシュ有り） */
  getActive() {
    assertReady();
    if (_rulesCache) return _rulesCache;
    _rulesCache = attachConditions(
      db.prepare(`SELECT * FROM v_rules_full WHERE enabled = 1 AND subject_enabled = 1
                  ORDER BY priority DESC, id`).all()
    );
    return _rulesCache;
  },
  /**
   * @param {{subjectId:number, name:string, conditions:Array,
   *          matchMode?:'all'|'any', priority?:number, enabled?:boolean,
   *          subfolder?:string, description?:string,
   *          origin?:'user'|'learned'|'builtin', confidence?:number}} p
   * @returns {number} ルールID
   */
  create(p) {
    assertReady();
    if (!p || !p.subjectId) throw new Error('subjectId は必須です');
    if (!Array.isArray(p.conditions) || p.conditions.length === 0) {
      throw new Error('conditions を1件以上指定してください');
    }
    const tx = db.transaction((params) => {
      const info = db.prepare(
        `INSERT INTO rules(subject_id, name, description, match_mode, priority, enabled,
                           subfolder, origin, confidence)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        params.subjectId,
        params.name || '無題のルール',
        nz(params.description),
        params.matchMode || 'all',
        params.priority ?? 100,
        toInt(params.enabled ?? true),
        nz(params.subfolder),
        params.origin || 'user',
        params.confidence ?? 1.0
      );
      insertConditions(info.lastInsertRowid, params.conditions);
      return info.lastInsertRowid;
    });
    const id = tx(p);
    invalidateRules();
    return id;
  },
  /** conditions を渡すと条件は総入れ替えされる */
  update(id, patch = {}) {
    assertReady();
    const map = {
      subjectId: 'subject_id', name: 'name', description: 'description',
      matchMode: 'match_mode', priority: 'priority', enabled: 'enabled',
      subfolder: 'subfolder', origin: 'origin', confidence: 'confidence',
    };
    const tx = db.transaction(() => {
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
    });
    tx();
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
  /** ヒットしたとき呼ぶ（統計用） */
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
 * content_cache — 本文抽出キャッシュ
 * ==========================================================================*/

const content = {
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
  count() {
    assertReady();
    return db.prepare('SELECT COUNT(*) AS n FROM content_cache').get().n;
  },
};

/* ============================================================================
 * queue — 監視で検知した未処理ファイル
 * ==========================================================================*/

const queue = {
  /** 同じパスが来たら更新（chokidar の重複検知対策） */
  add({ sourcePath, fileName = null, ext = null, sizeBytes = null, fileHash = null, status = 'pending' }) {
    assertReady();
    const name = fileName || path.basename(sourcePath);
    const e = ext ?? (path.extname(name).replace(/^\./, '').toLowerCase() || null);
    db.prepare(
      `INSERT INTO queue(source_path, file_name, ext, size_bytes, file_hash, status)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_path) DO UPDATE SET
         file_name = excluded.file_name, size_bytes = excluded.size_bytes,
         file_hash = excluded.file_hash, status = excluded.status,
         updated_at = ${nowSql}`
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
  get(id) {
    assertReady();
    return db.prepare('SELECT * FROM queue WHERE id = ?').get(id) || null;
  },
  setStatus(id, status, patch = {}) {
    assertReady();
    db.prepare(
      `UPDATE queue SET status = ?, matched_rule_id = COALESCE(?, matched_rule_id),
        matched_subject_id = COALESCE(?, matched_subject_id),
        suggested_json = COALESCE(?, suggested_json),
        score = COALESCE(?, score),
        error_message = ?, updated_at = ${nowSql}
       WHERE id = ?`
    ).run(
      status, nz(patch.ruleId), nz(patch.subjectId),
      patch.suggested ? JSON.stringify(patch.suggested) : null,
      nz(patch.score), nz(patch.errorMessage), id
    );
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

/* ============================================================================
 * history — 移動履歴
 * ==========================================================================*/

const history = {
  /**
   * @param {{fileName:string, sourcePath:string, destPath?:string, ext?:string,
   *          sizeBytes?:number, fileHash?:string, subjectId?:number, ruleId?:number,
   *          action?:'move'|'copy'|'skip'|'manual', status?:'success'|'failed'|'undone',
   *          matchedBy?:string, score?:number, errorMessage?:string}} p
   */
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
    const sql = `SELECT * FROM v_history_full
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY moved_at DESC, id DESC LIMIT ? OFFSET ?`;
    return db.prepare(sql).all(...vals, limit, offset);
  },
  get(id) {
    assertReady();
    return db.prepare('SELECT * FROM v_history_full WHERE id = ?').get(id) || null;
  },
  /** 「元に戻す」実行後に呼ぶ */
  markUndone(id) {
    assertReady();
    db.prepare("UPDATE history SET status = 'undone' WHERE id = ?").run(id);
    return true;
  },
  /** 同じ内容のファイルを過去に処理していないか */
  findByHash(fileHash) {
    assertReady();
    if (!fileHash) return null;
    return db.prepare(`SELECT * FROM history WHERE file_hash = ? AND status = 'success'
                       ORDER BY moved_at DESC LIMIT 1`).get(fileHash) || null;
  },
  /** ダッシュボード用の集計 */
  stats(days = 30) {
    assertReady();
    const since = `-${Number(days)} days`;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM history WHERE moved_at >= datetime('now','localtime', ?)`).get(since).n;
    const success = db.prepare(`SELECT COUNT(*) AS n FROM history WHERE status='success' AND moved_at >= datetime('now','localtime', ?)`).get(since).n;
    const failed = db.prepare(`SELECT COUNT(*) AS n FROM history WHERE status='failed' AND moved_at >= datetime('now','localtime', ?)`).get(since).n;
    const bySubject = db.prepare(
      `SELECT COALESCE(s.name, h.subject_name, '未分類') AS subject, COUNT(*) AS n
       FROM history h LEFT JOIN subjects s ON s.id = h.subject_id
       WHERE h.moved_at >= datetime('now','localtime', ?) AND h.status = 'success'
       GROUP BY subject ORDER BY n DESC`
    ).all(since);
    const byDay = db.prepare(
      `SELECT date(moved_at) AS day, COUNT(*) AS n FROM history
       WHERE moved_at >= datetime('now','localtime', ?) GROUP BY day ORDER BY day`
    ).all(since);
    const byMatchedBy = db.prepare(
      `SELECT COALESCE(matched_by,'unknown') AS matched_by, COUNT(*) AS n FROM history
       WHERE moved_at >= datetime('now','localtime', ?) AND status='success'
       GROUP BY matched_by ORDER BY n DESC`
    ).all(since);
    return { days, total, success, failed, bySubject, byDay, byMatchedBy };
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
       WHERE target = ? AND term IN (${part.map(() => '?').join(',')})`
    ).all(target, ...part);
    for (const r of rows) {
      if (!map.has(r.term)) map.set(r.term, new Map());
      map.get(r.term).set(r.subject_id, r.count);
    }
  }
  return map;
}

function fetchSubjectTotals(target) {
  const map = new Map();
  const rows = db.prepare(
    `SELECT ss.subject_id, ss.sample_count, ss.term_total
     FROM subject_stats ss JOIN subjects s ON s.id = ss.subject_id
     WHERE ss.target = ? AND s.enabled = 1`
  ).all(target);
  for (const r of rows) map.set(r.subject_id, { sampleCount: r.sample_count, termTotal: r.term_total });
  return map;
}

let _stmtUpsertTerm = null;
let _stmtUpsertSubjectStat = null;

function upsertTermStmt() {
  if (!_stmtUpsertTerm) {
    _stmtUpsertTerm = db.prepare(
      `INSERT INTO term_stats(term, target, subject_id, count, updated_at)
       VALUES(?, ?, ?, ?, ${nowSql})
       ON CONFLICT(term, target, subject_id)
       DO UPDATE SET count = count + excluded.count, updated_at = ${nowSql}`
    );
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
                     term_total   = term_total   + excluded.term_total`
    );
  }
  return _stmtUpsertSubjectStat;
}

/** 1サンプル分を term_stats に反映（トランザクション内で呼ぶこと） */
function applySample({ subjectId, fileName, text, weight = 1.0, sign = 1 }) {
  const upTerm = upsertTermStmt();
  const upStat = upsertSubjectStatStmt();
  const targets = [
    { target: 'filename', tokens: learner.tokenize(fileName, { isFileName: true, maxTerms: 80 }) },
    { target: 'content', tokens: learner.tokenize(text, { maxTerms: 400 }) },
  ];
  for (const { target, tokens } of targets) {
    if (!tokens.length) continue;
    for (const t of tokens) upTerm.run(t, target, subjectId, weight * sign);
    upStat.run(subjectId, target, weight * sign, tokens.length * weight * sign);
  }
}

const learn = {
  /**
   * ユーザーが手でファイルを科目フォルダに入れた（または判定を修正した）ことを学習する。
   * これが「手動配置による自動学習」の入口。
   *
   * @param {{subjectId:number, fileName:string, ext?:string, text?:string,
   *          fileHash?:string, source?:'manual_move'|'correction'|'confirm'|'import',
   *          weight?:number}} p
   * @returns {number} learning_samples の ID
   */
  record(p) {
    assertReady();
    if (!p || !p.subjectId || !p.fileName) throw new Error('subjectId と fileName は必須です');
    const source = p.source || 'manual_move';
    // 誤判定の修正は「強い教師データ」なので重みを大きくする
    const weight = p.weight ?? (source === 'correction' ? 2.0 : 1.0);
    const excerpt = p.text ? String(p.text).slice(0, 2000) : null;

    const tx = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO learning_samples(subject_id, file_name, ext, text_excerpt, file_hash, source, weight, applied)
         VALUES(?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(p.subjectId, p.fileName, nz(p.ext), excerpt, nz(p.fileHash), source, weight);
      applySample({ subjectId: p.subjectId, fileName: p.fileName, text: excerpt, weight, sign: 1 });
      return info.lastInsertRowid;
    });
    const id = tx();
    invalidateVocab();
    return id;
  },

  /**
   * 学習結果からファイルの科目を推定する
   * @param {{fileName:string, ext?:string, text?:string, topK?:number}} p
   * @returns {Array<{subjectId:number, subjectName:string, folderPath:string,
   *                  probability:number, score:number}>}
   */
  suggest({ fileName, text = null, topK = 3, minKnownTerms = 2, minSubjects = 2 } = {}) {
    assertReady();
    const fnTokens = learner.tokenize(fileName, { isFileName: true, maxTerms: 80 });
    const ctTokens = learner.tokenize(text, { maxTerms: 400 });

    const fnCounts = fnTokens.length ? fetchTermCounts('filename', fnTokens) : new Map();
    const ctCounts = ctTokens.length ? fetchTermCounts('content', ctTokens) : new Map();

    // ガード1: 学習済みの語がほとんど無いのに推定すると、単に「サンプルが多い科目」
    //          が常に選ばれてしまう。既知語が少なければ推定しない。
    if (fnCounts.size + ctCounts.size < minKnownTerms) return [];

    const fnTotals = fetchSubjectTotals('filename');
    const ctTotals = fetchSubjectTotals('content');

    // ガード2: 学習済みの科目が1つしか無い状態では比較にならない（確率が必ず1.0になる）
    const learnedSubjects = new Set([...fnTotals.keys(), ...ctTotals.keys()]);
    if (learnedSubjects.size < minSubjects) return [];

    const maps = [];
    if (fnCounts.size) {
      maps.push({
        weight: 1.5, // ファイル名は情報密度が高いので重め
        map: learner.scoreLog({
          tokens: fnTokens,
          termCounts: fnCounts,
          subjectTotals: fnTotals,
          vocabSize: vocabSize('filename'),
        }),
      });
    }
    if (ctCounts.size) {
      maps.push({
        weight: 1.0,
        map: learner.scoreLog({
          tokens: ctTokens,
          termCounts: ctCounts,
          subjectTotals: ctTotals,
          vocabSize: vocabSize('content'),
        }),
      });
    }
    if (!maps.length) return [];

    const ranked = learner.softmaxRank(learner.combineLogScores(maps));
    const out = [];
    for (const r of ranked.slice(0, topK)) {
      const s = subjects.get(r.subjectId);
      if (!s) continue;
      out.push({
        subjectId: r.subjectId,
        subjectName: s.name,
        folderPath: s.folder_path,
        probability: r.probability,
        score: r.score,
      });
    }
    return out;
  },

  /** 科目を特徴づける語（ルール自動生成／UI表示用） */
  distinctiveTerms(subjectId, { target = 'filename', minCount = 2, topN = 8, minRatio = 0.6 } = {}) {
    assertReady();
    const rows = db.prepare(
      `SELECT t.term, t.count,
              (SELECT SUM(t2.count) FROM term_stats t2 WHERE t2.term = t.term AND t2.target = t.target) AS totalCount
       FROM term_stats t
       WHERE t.subject_id = ? AND t.target = ? AND t.count >= ?
       ORDER BY t.count DESC LIMIT 300`
    ).all(subjectId, target, minCount);
    return learner.pickDistinctiveTerms(rows, { minCount, topN, minRatio });
  },

  /**
   * 学習結果を「見えるルール」に昇格させる（UIで編集・削除できるようになる）
   * @returns {number|null} 作成したルールID
   */
  promoteToRule(subjectId, { target = 'filename', topN = 5, minCount = 3, minRatio = 0.7, priority = 50 } = {}) {
    assertReady();
    const terms = learn.distinctiveTerms(subjectId, { target, minCount, topN, minRatio });
    if (!terms.length) return null;
    const s = subjects.get(subjectId);
    const conditions = terms.map((t) => ({
      target: target === 'content' ? 'content' : 'filename',
      operator: 'contains',
      value: t.term,
      caseSensitive: false,
    }));
    const confidence = terms.reduce((a, t) => a + t.ratio, 0) / terms.length;
    return rules.create({
      subjectId,
      name: `【自動学習】${s ? s.name : ''}`,
      description: `手動配置 ${terms.map((t) => t.term).join(' / ')} から自動生成`,
      matchMode: 'any',
      priority,
      origin: 'learned',
      confidence,
      conditions,
    });
  },

  /** learning_samples から統計を作り直す（科目削除やデータ不整合のリカバリ用） */
  rebuild() {
    assertReady();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM term_stats').run();
      db.prepare('DELETE FROM subject_stats').run();
      const samples = db.prepare(
        `SELECT ls.* FROM learning_samples ls JOIN subjects s ON s.id = ls.subject_id`
      ).all();
      for (const smp of samples) {
        applySample({
          subjectId: smp.subject_id, fileName: smp.file_name,
          text: smp.text_excerpt, weight: smp.weight, sign: 1,
        });
      }
      db.prepare('UPDATE learning_samples SET applied = 1').run();
      return samples.length;
    });
    const n = tx();
    invalidateVocab();
    return n;
  },

  /** ある科目の学習をリセット */
  forget(subjectId) {
    assertReady();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM learning_samples WHERE subject_id = ?').run(subjectId);
      db.prepare('DELETE FROM term_stats WHERE subject_id = ?').run(subjectId);
      db.prepare('DELETE FROM subject_stats WHERE subject_id = ?').run(subjectId);
    });
    tx();
    invalidateVocab();
    return true;
  },

  /** 学習状況（設定画面に出す用） */
  stats() {
    assertReady();
    const perSubject = db.prepare(
      `SELECT s.id AS subject_id, s.name,
              (SELECT COUNT(*) FROM learning_samples ls WHERE ls.subject_id = s.id) AS samples,
              (SELECT COUNT(*) FROM term_stats t WHERE t.subject_id = s.id) AS terms
       FROM subjects s ORDER BY s.sort_order, s.id`
    ).all();
    const total = db.prepare('SELECT COUNT(*) AS n FROM learning_samples').get().n;
    return { totalSamples: total, vocabFilename: vocabSize('filename'), vocabContent: vocabSize('content'), perSubject };
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
 * classify — ルール判定 →（当たらなければ）学習による推定
 * ==========================================================================*/

/**
 * ファイル1件の振り分け先を決める。振り分け処理担当はこれを呼べばよい。
 *
 * @param {{fileName:string, ext?:string, sizeBytes?:number, text?:string}} file
 * @param {{useLearning?:boolean, minConfidence?:number}} [opts]
 * @returns {{
 *   matched: boolean,
 *   source: 'rule'|'learning'|null,
 *   subjectId: number|null, subjectName: string|null, folderPath: string|null,
 *   subfolder: string|null, ruleId: number|null, matchedBy: string|null,
 *   confidence: number, suggestions: Array
 * }}
 */
function classify(file, opts = {}) {
  assertReady();
  const useLearning = opts.useLearning ?? settings.getBool('learning_enabled', true);
  const minConfidence = opts.minConfidence ?? settings.getNumber('learning_min_confidence', 0.6);

  const empty = {
    matched: false, source: null, subjectId: null, subjectName: null,
    folderPath: null, subfolder: null, ruleId: null, matchedBy: null,
    confidence: 0, suggestions: [],
  };

  // 1) 明示的なルール（決定的・優先）
  const r = matcher.classify(rules.getActive(), file);
  if (r.matched) {
    const s = subjects.get(r.subjectId);
    return {
      matched: true, source: 'rule',
      subjectId: r.subjectId, subjectName: s ? s.name : null,
      folderPath: s ? s.folder_path : null,
      subfolder: r.rule.subfolder || null,
      ruleId: r.rule.id, matchedBy: r.matchedBy,
      confidence: r.rule.confidence ?? 1.0,
      suggestions: [],
    };
  }

  // 2) 手動配置の学習による推定
  if (!useLearning) return empty;
  const suggestions = learn.suggest({ fileName: file.fileName, text: file.text, topK: 3 });
  if (!suggestions.length) return empty;

  const top = suggestions[0];
  if (top.probability < minConfidence) {
    return { ...empty, suggestions };  // 自信が無いのでUIで確認させる
  }
  return {
    matched: true, source: 'learning',
    subjectId: top.subjectId, subjectName: top.subjectName,
    folderPath: top.folderPath, subfolder: null,
    ruleId: null, matchedBy: file.text ? 'both' : 'filename',
    confidence: top.probability,
    suggestions,
  };
}

/* ============================================================================
 * メンテナンス
 * ==========================================================================*/

function vacuum() { assertReady(); db.exec('VACUUM'); return true; }

/** 定期メンテ（起動時などに呼ぶ） */
function maintenance() {
  assertReady();
  const removedHistory = history.purgeOlderThan();
  const removedCache = content.purgeOlderThan(90);
  queue.clearDone();
  return { removedHistory, removedCache };
}

module.exports = {
  init, close, getDb, migrate, backup, vacuum, maintenance,
  settings, subjects, rules, conditions: { insertConditions },
  content, queue, history, learn,
  classify,
  // 低レベルユーティリティ（テスト・拡張用）
  matcher, learner,
};
