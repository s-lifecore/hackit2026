/**
 * mock-api.js — window.api を Electron なしで再現するブラウザ用ダミー実装
 * =============================================================================
 * <script src="mock-api.js"></script> を <script src="preload相当"> の代わりに読み込むだけで、
 * file-auto-sort.wired.html がそのまま動く。
 *
 * 目的: UI担当がElectronのビルド・electron-rebuildを待たずに、
 * 本番と同じ window.api の形（同じ関数名・同じ戻り値の形）で作業を続けられるようにするため。
 * ここでの判定ロジックは本物の db.classify（ルール→別名→学習）を大幅に簡略化したもので、
 * 「キーワードを含むか」だけを見る。本番の挙動とは異なるので注意（ipc-contract.md 参照）。
 *
 * データはページを開いている間だけメモリ上に存在し、リロードで消える
 * （元のデモHTMLと同じ挙動。永続化はしない）。
 * =============================================================================
 */
(function () {
  'use strict';

  const uid = (() => { let n = 1; return (p) => `${p}_${n++}`; })();
  const nowIso = () => new Date().toISOString();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------------------------------------------------- 内部状態 */
  const state = {
    subjects: [],           // {id, name, folderPath, color, enabled}
    keywords: new Map(),    // subjectId -> string
    watch: { folder: '~/Desktop/提出物', enabled: true, connected: true },
    queue: [],              // {id, fileName, ext, sizeBytes, status, detectedAt, subjectId}
    history: [],            // {id, fileName, sourcePath, destPath, subjectId, subjectName, status, movedAt}
    settings: { learning_enabled: '1' },
    nextFileSeq: 0,
    setupCompleted: false,
    lastScan: null,
    scanRuns: [],
  };

  const listeners = new Map(); // eventName -> Set<fn>
  function emit(eventName, payload) {
    for (const fn of listeners.get(eventName) || []) {
      try { fn(payload); } catch (e) { console.error('[mock-api] listener error', eventName, e); }
    }
  }

  /** 「元に戻す」用: 対応するキュー項目を pending に戻す（ファイル名一致・簡易版） */
  function revertQueueItem(fileName) {
    const item = [...state.queue].reverse().find((q) => q.fileName === fileName && q.status === 'done');
    if (item) { item.status = 'pending'; item.subjectId = null; }
  }

  /* ---------------------------------------------------------- 判定（簡易版） */
  function classify(fileName) {
    for (const s of state.subjects) {
      const kw = state.keywords.get(s.id);
      if (kw && fileName.includes(kw)) {
        return { matched: true, subjectId: s.id, subjectName: s.name, folderPath: s.folderPath, matchedBy: 'filename', confidence: 0.9 };
      }
    }
    return { matched: false, suggestions: [] };
  }

  /* ---------------------------------------------------------- サンプルファイル生成（元デモの発想を流用） */
  const STUDENTS = ['山田', '佐藤', '鈴木', '田中', '高橋', '伊藤', '渡辺', '中村', '小林', '加藤', '吉田', '山本', '岡田', '村上', '近藤'];
  const CODES = ['3A-12', '3B-04', '3C-19', '3A-07', '3B-21', '3C-02', '3A-15', '3B-09', '3C-11', '3A-03', '3B-17', '3C-06', '3A-22', '3B-13', '3C-08'];

  function makeSampleFile(subject) {
    const n = state.nextFileSeq++;
    const ext = n % 2 ? 'pdf' : 'docx';
    const fileName = subject
      ? `${CODES[n % CODES.length]}_${STUDENTS[n % STUDENTS.length]}_${subject.name}.${ext}`
      : `スキャン_${String(n).padStart(4, '0')}.${ext}`;
    return {
      id: uid('q'), fileName, ext, sizeBytes: 40000 + n * 777,
      status: 'pending', detectedAt: nowIso(), subjectId: null, fileHash: null,
    };
  }

  /* ============================================================================
   * window.api 本体
   * ==========================================================================*/
  window.api = {
    subjects: {
      async list() { return state.subjects.slice(); },
      async get(id) { return state.subjects.find((s) => s.id === id) || null; },

      async createMany(names, baseFolder) {
        const out = [];
        for (const name of names) {
          const s = { id: uid('s'), name, folderPath: `${baseFolder}/${name}`, color: null, enabled: 1 };
          state.subjects.push(s);
          state.keywords.set(s.id, name); // 初期キーワード＝科目名
          out.push(s);
        }
        // デモ用にサンプルファイルを何件か投入
        state.subjects.forEach((s) => {
          for (let k = 0; k < 2; k++) state.queue.push(makeSampleFile(s));
        });
        state.queue.push(makeSampleFile(null));
        return out;
      },

      async importFromFolder(root) {
        // ブラウザ実験では実フォルダを読めないため、固定サンプルを返す
        const names = ['現代文', '数学Ⅱ', '英語表現', '日本史B', '物理基礎'];
        const created = await window.api.subjects.createMany(names, root);
        return { created, skipped: [] };
      },

      async update(id, patch) {
        const s = state.subjects.find((x) => x.id === id);
        if (s) Object.assign(s, patch);
        return true;
      },
      async remove(id) {
        state.subjects = state.subjects.filter((s) => s.id !== id);
        state.keywords.delete(id);
        return true;
      },
    },

    rules: {
      async getKeywords() {
        const out = {};
        for (const s of state.subjects) out[s.id] = state.keywords.get(s.id) || '';
        return out;
      },
      async setKeyword(subjectId, keyword) {
        state.keywords.set(subjectId, String(keyword || '').trim());
        return { ok: true, ruleId: subjectId, enabled: !!keyword };
      },
      async list() { return []; },
      async create() { throw new Error('mock-api: rules.create 未実装（本番のみ）'); },
      async update() { throw new Error('mock-api: rules.update 未実装（本番のみ）'); },
      async remove() { throw new Error('mock-api: rules.remove 未実装（本番のみ）'); },
    },

    aliases: {
      async list() { return []; },
      async add() { return null; },
    },

    scan: {
      async getStatus() {
        return {
          folder: state.watch.folder,
          scanOnStartup: state.watch.enabled,
          lastScan: state.lastScan,
        };
      },
      async setFolder(folderPath) { state.watch.folder = folderPath; return { folder: folderPath }; },
      async setOnStartup(bool) { state.watch.enabled = !!bool; return state.watch.enabled; },
      async history() { return state.scanRuns.slice().reverse(); },

      /** 起動時スキャンと同じ処理を手動で走らせる */
      async runNow() { return runMockScan('manual'); },
    },

    startup: {
      async get() { return { openAtLogin: true, saved: true }; },
      async set(enabled) { return { openAtLogin: !!enabled }; },
    },

    shell: {
      async openFolder(folderPath) {
        alert(`（モック）エクスプローラーでここを開きます:\n${folderPath}`);
        return { ok: true };
      },
      async revealFile(filePath) {
        alert(`（モック）ここを表示します:\n${filePath}`);
        return { ok: true };
      },
    },

    app: {
      async getState() {
        return { setupCompleted: state.setupCompleted, subjectCount: state.subjects.length };
      },
      async completeSetup() { state.setupCompleted = true; return true; },
    },

    queue: {
      async list(status) {
        return status ? state.queue.filter((q) => q.status === status) : state.queue.slice();
      },
      async countByStatus() {
        const out = {};
        for (const q of state.queue) out[q.status] = (out[q.status] || 0) + 1;
        return out;
      },
      async processAll(ids) {
        const targets = ids?.length ? state.queue.filter((q) => ids.includes(q.id)) : state.queue.filter((q) => q.status === 'pending');
        const results = [];
        for (const item of targets) {
          const r = classify(item.fileName);
          if (!r.matched) {
            item.status = 'unmatched';
            results.push({ id: item.id, matched: false, suggestions: [] });
            continue;
          }
          item.status = 'done';
          item.subjectId = r.subjectId;
          const destPath = `${r.folderPath}/${item.fileName}`;
          state.history.push({
            id: uid('h'), fileName: item.fileName, sourcePath: `~/Downloads/${item.fileName}`,
            destPath, subjectId: r.subjectId, subjectName: r.subjectName,
            status: 'success', matchedBy: r.matchedBy, movedAt: nowIso(),
          });
          results.push({
            id: item.id, matched: true, moved: true, subjectId: r.subjectId,
            subjectName: r.subjectName, destPath, matchedBy: r.matchedBy, confidence: r.confidence,
          });
        }
        return results;
      },
      async moveManually(fileId, subjectId) {
        const item = state.queue.find((q) => q.id === fileId);
        const subject = state.subjects.find((s) => s.id === subjectId);
        if (!item || !subject) throw new Error('mock-api: ファイルまたは科目が見つかりません');
        item.status = 'done';
        item.subjectId = subjectId;
        const destPath = `${subject.folderPath}/${item.fileName}`;
        state.history.push({
          id: uid('h'), fileName: item.fileName, sourcePath: `~/Downloads/${item.fileName}`,
          destPath, subjectId, subjectName: subject.name,
          status: 'success', matchedBy: 'manual', movedAt: nowIso(),
        });
        return { id: fileId, subjectId, subjectName: subject.name, destPath, moved: true };
      },
    },

    history: {
      async list(opts = {}) {
        let rows = state.history.slice().reverse();
        if (opts.subjectId) rows = rows.filter((r) => r.subjectId === opts.subjectId);
        return rows.slice(0, opts.limit || 100);
      },
      async stats() {
        const bySubject = {};
        for (const r of state.history) bySubject[r.subjectName] = (bySubject[r.subjectName] || 0) + 1;
        return {
          total: state.history.length,
          success: state.history.filter((r) => r.status === 'success').length,
          failed: state.history.filter((r) => r.status === 'failed').length,
          bySubject: Object.entries(bySubject).map(([subject, n]) => ({ subject, n })),
        };
      },
      async undo(id) {
        const r = state.history.find((x) => x.id === id);
        if (!r) return true;
        r.status = 'undone';
        revertQueueItem(r.fileName);
        return true;
      },
      async undoLast(n = 1) {
        const rows = state.history.filter((r) => r.status === 'success').slice(-n);
        rows.forEach((r) => { r.status = 'undone'; revertQueueItem(r.fileName); });
        return rows.map((r) => r.id);
      },
      async countBySubject() {
        const out = {};
        for (const r of state.history) {
          if (r.status !== 'success') continue;
          out[r.subjectId] = (out[r.subjectId] || 0) + 1;
        }
        return out;
      },
    },

    settings: {
      async get(key, def) { return key in state.settings ? state.settings[key] : (def ?? null); },
      async set(key, value) { state.settings[key] = value; return true; },
      async getAll() { return { ...state.settings }; },
    },

    dialog: {
      /** OSダイアログの代わりに、簡単な入力を求める（実験用の割り切り） */
      async chooseFolder() {
        const p = window.prompt('（モック）フォルダのパスを入力してください', '~/Desktop/提出物');
        return p ? { path: p } : null;
      },
    },

    on(eventName, callback) {
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName).add(callback);
    },
    off(eventName, callback) {
      listeners.get(eventName)?.delete(callback);
    },
  };

  /* ============================================================================
   * 一括スキャン（常時監視の置き換え）
   * 本番の startup-scan.js と同じイベントを、同じ順序で流す
   * ==========================================================================*/
  async function runMockScan(trigger) {
    emit('scan:start', { folder: state.watch.folder });

    const pending = state.queue.filter((q) => q.status === 'pending');
    const summary = { runId: uid('run'), folder: state.watch.folder, scanned: 0, moved: 0, unmatched: 0, failed: 0, results: [] };

    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      emit('scan:progress', { index: i + 1, total: pending.length, fileName: item.fileName });
      await wait(90);
      summary.scanned++;

      const r = classify(item.fileName);
      if (!r.matched) {
        item.status = 'unmatched';
        summary.unmatched++;
        summary.results.push({ queueId: item.id, fileName: item.fileName, matched: false, suggestions: [] });
        continue;
      }
      item.status = 'done';
      item.subjectId = r.subjectId;
      const destPath = `${r.folderPath}/${item.fileName}`;
      state.history.push({
        id: uid('h'), fileName: item.fileName, sourcePath: `${state.watch.folder}/${item.fileName}`,
        destPath, subjectId: r.subjectId, subjectName: r.subjectName,
        status: 'success', matchedBy: r.matchedBy, movedAt: nowIso(),
      });
      summary.moved++;
      summary.results.push({
        queueId: item.id, fileName: item.fileName, matched: true, moved: true,
        subjectId: r.subjectId, subjectName: r.subjectName, destPath,
        matchedBy: r.matchedBy, confidence: r.confidence,
      });
    }

    const run = {
      id: summary.runId, trigger, started_at: nowIso(), finished_at: nowIso().slice(0, 19).replace('T', ' '),
      scanned: summary.scanned, moved: summary.moved, unmatched: summary.unmatched, failed: 0,
    };
    state.scanRuns.push(run);
    state.lastScan = run;

    emit('scan:done', summary);
    return summary;
  }

  console.info('[mock-api] window.api はブラウザ用ダミー実装です（back/mock-api.js）。本番は back/preload.js に差し替えてください。');
})();
