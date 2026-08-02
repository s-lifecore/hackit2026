'use strict';
/**
 * store.js — 永続化層（JSONファイル）
 *
 * ■ なぜ SQLite を使わないか
 *   better-sqlite3 はネイティブモジュールで、Visual Studio Build Tools が無い PC では
 *   npm install に失敗する。各自の PC でビルドする前提だと事故になりやすいため、
 *   ネイティブ依存ゼロの JSON ファイル方式にした。
 *   データ量（科目10件・キュー数百件程度）では速度上の問題も無い。
 *
 * ■ 書き込みの工夫（PCの負荷を上げないため）
 *   ・変更のたびに書かず、200ms のデバウンスでまとめて書く
 *   ・一時ファイルへ書いてから rename する（書き込み途中で電源が落ちても壊れない）
 *   ・抽出テキストのキャッシュは本体と別ファイルに分け、件数に上限を設ける
 *     （本体JSONが肥大化して毎回の書き込みが重くなるのを避ける）
 */
const fs = require('fs');
const path = require('path');

const FLUSH_DELAY_MS = 200;
const CACHE_MAX_ENTRIES = 400;   // 抽出テキストのキャッシュ上限（古いものから捨てる）

/** 一時ファイル経由で安全に書き込む */
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);   // Windows でも既存ファイルを上書きできる
}

/** 壊れていたら退避して初期状態に戻す */
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[store] 読み込みに失敗したので初期化します:', file, e.message);
    try { fs.renameSync(file, file + '.broken-' + Date.now()); } catch (_) {}
    return fallback;
  }
}

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.kind = 'json';
    this.mainFile = path.join(dir, 'filefly.json');
    this.cacheFile = path.join(dir, 'text-cache.json');

    const empty = {
      settings: {}, subjects: [], queue: [], history: [], tokens: [], scans: [],
      seq: { queue: 0, history: 0, scans: 0 }
    };
    this.d = Object.assign(empty, readJson(this.mainFile, {}));
    this.d.seq = Object.assign({ queue: 0, history: 0, scans: 0 }, this.d.seq);
    this.cache = readJson(this.cacheFile, {});

    this._dirtyMain = false;
    this._dirtyCache = false;
    this._timer = null;
  }

  /* ---------------- 書き込み制御 ---------------- */
  _touch(which) {
    if (which === 'cache') this._dirtyCache = true; else this._dirtyMain = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, FLUSH_DELAY_MS);
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try {
      if (this._dirtyMain) { writeAtomic(this.mainFile, JSON.stringify(this.d)); this._dirtyMain = false; }
      if (this._dirtyCache) { writeAtomic(this.cacheFile, JSON.stringify(this.cache)); this._dirtyCache = false; }
    } catch (e) {
      console.warn('[store] 保存に失敗:', e.message);
    }
  }

  close() { this.flush(); }

  /* ---------------- settings ---------------- */
  get(key, fallback = null) {
    return Object.prototype.hasOwnProperty.call(this.d.settings, key) ? this.d.settings[key] : fallback;
  }
  set(key, value) { this.d.settings[key] = value; this._touch('main'); }

  /* ---------------- subjects ---------------- */
  listSubjects() {
    return this.d.subjects.slice().sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
  }
  replaceSubjects(rows) {
    this.d.subjects = rows.map((s, i) => ({
      id: s.id, name: s.name, folder_path: s.folder_path, keyword: s.keyword || '', sort_order: i
    }));
    this._touch('main');
  }
  setKeyword(id, keyword) {
    const s = this.d.subjects.find(x => x.id === id);
    if (s) { s.keyword = keyword; this._touch('main'); }
  }
  removeSubject(id) {
    const before = this.d.subjects.length;
    this.d.subjects = this.d.subjects.filter(s => s.id !== id);
    this.d.tokens = this.d.tokens.filter(t => t.subject_id !== id);
    if (this.d.subjects.length !== before) this._touch('main');
    return this.d.subjects.length !== before;
  }
  /**
   * 科目フォルダが実際にディスク上に存在するか確認する（アプリ起動時に1回だけ呼ぶ想定）。
   * エクスプローラーで削除されたフォルダがあれば、その科目をアプリの一覧からも取り除く。
   * ※ 逆に「無いなら作り直す」ことはしない＝エクスプローラー側の削除をそのまま尊重する。
   * @returns {Array<{id:string, name:string}>} アプリから取り除かれた科目
   */
  pruneMissingSubjects() {
    const kept = [];
    const removed = [];
    for (const s of this.d.subjects) {
      if (fs.existsSync(s.folder_path)) kept.push(s);
      else removed.push(s);
    }
    if (removed.length) {
      this.d.subjects = kept;
      const removedIds = new Set(removed.map(s => s.id));
      this.d.tokens = this.d.tokens.filter(t => !removedIds.has(t.subject_id));
      this._touch('main');
    }
    return removed.map(s => ({ id: s.id, name: s.name }));
  }

  /* ---------------- queue ---------------- */
  listQueue() {
    return this.d.queue.slice().sort((a, b) =>
      String(b.detected_at || '').localeCompare(String(a.detected_at || '')) || (b.id - a.id));
  }
  getQueue(id) { return this.d.queue.find(q => q.id === Number(id)); }
  findQueueBySource(p) { return this.d.queue.find(q => q.source_path === p); }
  insertQueue(row) {
    const id = ++this.d.seq.queue;
    this.d.queue.push({ id, status: 'waiting', subject_id: null, score: 0, reason: '', ...row });
    this._touch('main');
    return id;
  }
  updateQueue(id, patch) {
    const q = this.getQueue(id);
    if (q) { Object.assign(q, patch); this._touch('main'); }
  }
  deleteQueue(id) {
    const n = this.d.queue.length;
    this.d.queue = this.d.queue.filter(q => q.id !== Number(id));
    if (this.d.queue.length !== n) this._touch('main');
  }

  /* ---------------- history ---------------- */
  insertHistory(row) {
    const id = ++this.d.seq.history;
    this.d.history.push({ id, undone: 0, ...row });
    this._touch('main');
    return id;
  }
  countBySubject() {
    const out = {};
    for (const h of this.d.history) if (!h.undone) out[h.subject_id] = (out[h.subject_id] || 0) + 1;
    return out;
  }
  recentHistory(limit) {
    return this.d.history.filter(h => !h.undone).sort((a, b) => b.id - a.id).slice(0, limit);
  }
  markUndone(id) {
    const h = this.d.history.find(x => x.id === id);
    if (h) { h.undone = 1; this._touch('main'); }
  }

  /* ---------------- 学習した語 ---------------- */
  bumpToken(subjectId, token, field, delta) {
    let t = this.d.tokens.find(x => x.subject_id === subjectId && x.token === token && x.field === field);
    if (!t) {
      if (delta <= 0) return;                 // 取り消しで新規作成する意味は無い
      t = { subject_id: subjectId, token, field, weight: 0 };
      this.d.tokens.push(t);
    }
    t.weight = Math.max(0, t.weight + delta);
    if (t.weight <= 0.01) this.d.tokens = this.d.tokens.filter(x => x !== t);
    this._touch('main');
  }
  listTokens() { return this.d.tokens.filter(t => t.weight > 0.01); }
  clearTokensForSubject(id) {
    const n = this.d.tokens.length;
    this.d.tokens = this.d.tokens.filter(t => t.subject_id !== id);
    if (this.d.tokens.length !== n) this._touch('main');
  }

  /* ---------------- スキャン記録 ---------------- */
  startScan(trigger) {
    const id = ++this.d.seq.scans;
    this.d.scans.push({
      id, started_at: new Date().toISOString(), trigger,
      finished_at: null, scanned: 0, moved: 0, unmatched: 0
    });
    if (this.d.scans.length > 100) this.d.scans = this.d.scans.slice(-100);
    this._touch('main');
    return id;
  }
  finishScan(id, s) {
    const r = this.d.scans.find(x => x.id === id);
    if (r) {
      Object.assign(r, {
        finished_at: new Date().toISOString(),
        scanned: s.scanned, moved: s.moved, unmatched: s.unmatched
      });
      this._touch('main');
    }
  }
  lastScan() {
    const done = this.d.scans.filter(s => s.finished_at);
    return done.length ? done[done.length - 1] : null;
  }

  /* ---------------- 抽出テキストのキャッシュ ---------------- */
  getCachedText(p, mtime, size) {
    const c = this.cache[p];
    if (!c || c.mtime !== mtime || c.size !== size) return null;
    c.at = Date.now();                        // 最終利用時刻を更新（古いものから捨てるため）
    return c.text;
  }
  putCachedText(p, mtime, size, text) {
    this.cache[p] = { mtime, size, text, at: Date.now() };
    const keys = Object.keys(this.cache);
    if (keys.length > CACHE_MAX_ENTRIES) {
      keys.sort((a, b) => (this.cache[a].at || 0) - (this.cache[b].at || 0));
      for (const k of keys.slice(0, keys.length - CACHE_MAX_ENTRIES)) delete this.cache[k];
    }
    this._touch('cache');
  }
}

function createStore(userDataDir) { return new Store(userDataDir); }

module.exports = { createStore, Store };
