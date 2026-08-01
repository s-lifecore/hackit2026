'use strict';
/**
 * マイグレーション定義
 * -----------------------------------------------------------------------------
 * version を 1 から連番で増やしていく。既存ユーザーのDBを壊さずに
 * スキーマ変更するため、既存の SQL は絶対に書き換えず「追記」すること。
 * （例: 列を足したい → version 2 を新しく追加して ALTER TABLE を書く）
 */

const MIGRATIONS = [
  {
    version: 1,
    name: 'init',
    sql: /* sql */ `
--------------------------------------------------------------------------------
-- 1. settings : アプリ設定（キー・バリュー）
--------------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

--------------------------------------------------------------------------------
-- 2. subjects : 科目（＝振り分け先フォルダ）
--------------------------------------------------------------------------------
CREATE TABLE subjects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,          -- 例: 線形代数
  folder_path TEXT    NOT NULL,                 -- 例: D:\\大学\\2026前期\\線形代数
  color       TEXT,                             -- UIの色（#RRGGBB）
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_subjects_order ON subjects(enabled, sort_order, id);

--------------------------------------------------------------------------------
-- 3. rules : 振り分けルール（1ルール = 1科目へのマッピング）
--------------------------------------------------------------------------------
CREATE TABLE rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  description     TEXT,
  -- all: 全条件AND / any: いずれかOR
  match_mode      TEXT    NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all','any')),
  priority        INTEGER NOT NULL DEFAULT 100,   -- 大きいほど優先
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  subfolder       TEXT,                           -- 科目フォルダ配下のサブフォルダ 例: 課題
  -- user: 人が作った / learned: 手動配置から自動生成 / builtin: 初期ルール
  origin          TEXT    NOT NULL DEFAULT 'user' CHECK (origin IN ('user','learned','builtin')),
  confidence      REAL    NOT NULL DEFAULT 1.0,   -- learned のときの確信度 0.0-1.0
  hit_count       INTEGER NOT NULL DEFAULT 0,
  last_matched_at TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_rules_subject  ON rules(subject_id);
CREATE INDEX idx_rules_active   ON rules(enabled, priority DESC, id);

--------------------------------------------------------------------------------
-- 4. rule_conditions : ルールの判定条件（ファイル名 / 拡張子 / 内容 / サイズ）
--------------------------------------------------------------------------------
CREATE TABLE rule_conditions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id        INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  target         TEXT    NOT NULL CHECK (target IN ('filename','extension','content','size','any_text')),
  operator       TEXT    NOT NULL CHECK (operator IN
                   ('contains','not_contains','equals','starts_with','ends_with','regex','in','gt','lt')),
  value          TEXT    NOT NULL,               -- 'in' の場合はカンマ区切り 例: pdf,docx
  case_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (case_sensitive IN (0,1)),
  sort_order     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_conditions_rule ON rule_conditions(rule_id, sort_order);

--------------------------------------------------------------------------------
-- 5. content_cache : PDF/Word から抽出した本文のキャッシュ
--    ハッシュをキーにして同じファイルの再解析を防ぐ
--------------------------------------------------------------------------------
CREATE TABLE content_cache (
  file_hash    TEXT PRIMARY KEY,                 -- sha1 など
  text         TEXT,
  char_count   INTEGER NOT NULL DEFAULT 0,
  extractor    TEXT,                             -- pdf-parse / mammoth など
  truncated    INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  extracted_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_cache_at ON content_cache(extracted_at);

--------------------------------------------------------------------------------
-- 6. queue : 監視で検知した未処理ファイル（chokidar → ここに積む）
--------------------------------------------------------------------------------
CREATE TABLE queue (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path        TEXT    NOT NULL UNIQUE,
  file_name          TEXT    NOT NULL,
  ext                TEXT,
  size_bytes         INTEGER,
  file_hash          TEXT,
  status             TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN
                       ('pending','extracting','matched','unmatched','processing','done','error')),
  matched_rule_id    INTEGER REFERENCES rules(id)    ON DELETE SET NULL,
  matched_subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
  suggested_json     TEXT,                        -- 学習による候補（JSON配列）
  score              REAL,
  error_message      TEXT,
  detected_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_queue_status ON queue(status, detected_at);

--------------------------------------------------------------------------------
-- 7. history : 移動履歴（元に戻す機能・統計表示に使用）
--    科目やルールが削除されても残るよう名前をスナップショットで保持
--------------------------------------------------------------------------------
CREATE TABLE history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name     TEXT    NOT NULL,
  source_path   TEXT    NOT NULL,
  dest_path     TEXT,
  ext           TEXT,
  size_bytes    INTEGER,
  file_hash     TEXT,
  subject_id    INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
  subject_name  TEXT,
  rule_id       INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  rule_name     TEXT,
  action        TEXT NOT NULL DEFAULT 'move'    CHECK (action IN ('move','copy','skip','manual')),
  status        TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','failed','undone')),
  -- 何で当たったか: filename / content / both / learned / manual
  matched_by    TEXT,
  score         REAL,
  error_message TEXT,
  moved_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_history_at      ON history(moved_at DESC);
CREATE INDEX idx_history_subject ON history(subject_id, moved_at DESC);
CREATE INDEX idx_history_hash    ON history(file_hash);
CREATE INDEX idx_history_status  ON history(status);

--------------------------------------------------------------------------------
-- 8. learning_samples : 「手動配置による自動学習」の教師データ
--    ユーザーが自分でフォルダへ入れた／AIの判定を修正した記録
--------------------------------------------------------------------------------
CREATE TABLE learning_samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id   INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  file_name    TEXT    NOT NULL,
  ext          TEXT,
  text_excerpt TEXT,                              -- 本文の先頭N文字（学習用）
  file_hash    TEXT,
  -- manual_move: 手動でフォルダに入れた / correction: 誤判定を修正 / confirm: 提案を承認
  source       TEXT    NOT NULL DEFAULT 'manual_move'
                 CHECK (source IN ('manual_move','correction','confirm','import')),
  weight       REAL    NOT NULL DEFAULT 1.0,      -- correction は重めにするなど
  applied      INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0,1)), -- term_statsへ反映済みか
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_samples_subject ON learning_samples(subject_id);
CREATE INDEX idx_samples_applied ON learning_samples(applied);

--------------------------------------------------------------------------------
-- 9. term_stats : 学習済み語彙統計（ナイーブベイズ用）
--    term × target × subject の出現回数
--------------------------------------------------------------------------------
CREATE TABLE term_stats (
  term       TEXT    NOT NULL,
  target     TEXT    NOT NULL CHECK (target IN ('filename','content')),
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  count      REAL    NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (term, target, subject_id)
) WITHOUT ROWID;
CREATE INDEX idx_terms_lookup  ON term_stats(term, target);
CREATE INDEX idx_terms_subject ON term_stats(subject_id, target);

--------------------------------------------------------------------------------
-- 10. subject_stats : 科目ごとの学習件数（ベイズの事前確率・正規化用）
--------------------------------------------------------------------------------
CREATE TABLE subject_stats (
  subject_id   INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  target       TEXT    NOT NULL CHECK (target IN ('filename','content')),
  sample_count REAL    NOT NULL DEFAULT 0,        -- 学習した文書数
  term_total   REAL    NOT NULL DEFAULT 0,        -- 累計の語出現数
  PRIMARY KEY (subject_id, target)
) WITHOUT ROWID;

--------------------------------------------------------------------------------
-- 便利ビュー
--------------------------------------------------------------------------------
CREATE VIEW v_rules_full AS
SELECT r.*,
       s.name        AS subject_name,
       s.folder_path AS subject_folder,
       s.color       AS subject_color,
       s.enabled     AS subject_enabled
FROM rules r JOIN subjects s ON s.id = r.subject_id;

CREATE VIEW v_history_full AS
SELECT h.*, COALESCE(s.name, h.subject_name) AS display_subject
FROM history h LEFT JOIN subjects s ON s.id = h.subject_id;

--------------------------------------------------------------------------------
-- 初期設定値
--------------------------------------------------------------------------------
INSERT INTO settings(key, value) VALUES
  ('watch_folder',            ''),
  ('destination_root',        ''),
  ('auto_move_enabled',       '1'),
  ('confirm_before_move',     '0'),
  ('watch_extensions',        'pdf,docx,doc,pptx,xlsx,txt,zip'),
  ('content_scan_enabled',    '1'),
  ('content_scan_max_chars',  '20000'),
  ('learning_enabled',        '1'),
  ('learning_min_confidence', '0.6'),
  ('duplicate_action',        'rename'),
  ('history_retention_days',  '365');
`,
  },
];

module.exports = { MIGRATIONS };
