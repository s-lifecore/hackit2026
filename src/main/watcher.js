'use strict';
/**
 * watcher.js — エクスプローラー側の変更をリアルタイムに検知する
 *
 * fs.watch は OS のファイル変更通知（Windows なら ReadDirectoryChangesW）を
 * そのまま受け取る仕組みで、自分から定期的に全ファイルを読みにいくポーリングとは違う。
 * そのため常駐させても CPU はほとんど使わない。
 *
 * ただし OS の通知には
 *   ・短時間に大量に飛んでくる（フォルダを1つコピーしただけで数十件）
 *   ・環境によってはまれに取りこぼす
 * という性質があるため、次の2段構えにしている。
 *   1. 連続した通知はまとめて1回にする（デバウンス）
 *   2. 保険として一定間隔でも点検する（セーフティ）
 */
const fs = require('fs');

const DEBOUNCE_MS = 350;     // 連続した通知をまとめる時間
const SAFETY_MS   = 20000;   // 取りこぼし対策の点検間隔

/**
 * @param {(reason:string)=>void} onChange 変更を検知したときに呼ばれる
 */
function createWatcher(onChange) {
  let watchers = [];
  let debounceTimer = null;
  let safetyTimer = null;
  let paused = 0;      // アプリ自身がファイルを動かしている間は止める
  let dirty = false;   // 止めている間／実行中に変更があったか
  let running = false; // onChange を実行中か

  /**
   * onChange を1本だけ走らせる。
   * onChange（＝同期処理）が DEBOUNCE_MS より長くかかる場合、待ち合わせが無いと
   * 前回が終わる前に次が始まって二重に走る。実行中は dirty に積むだけにする。
   */
  async function run(reason) {
    running = true;
    try {
      await onChange(reason);
    } catch (e) {
      console.error('[watcher]', e);
    } finally {
      running = false;
      // 実行中に来ていた変更をここで拾い直す
      if (dirty && paused === 0) { dirty = false; fire('pending'); }
    }
  }

  function fire(reason) {
    if (paused > 0 || running) { dirty = true; return; }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
<<<<<<< HEAD
      if (paused > 0) { dirty = true; return; }
      try { onChange(reason); } catch (e) { console.error('[watcher]', e); }
=======
      // タイマーを仕掛けてから発火するまでの間に pause() されている（あるいは
      // 別の実行が始まっている）ことがあるため、ここでもう一度確認する。
      // 確認しないと、アプリ自身がファイルを移動している最中に同期が割り込む。
      if (paused > 0 || running) { dirty = true; return; }
      run(reason);
>>>>>>> 2ace96b3f9d69a22e0df1ad015f5539b5bf00386
    }, DEBOUNCE_MS);
  }

  function closeAll() {
    for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
    watchers = [];
  }

  function watchOne(dir, recursive) {
    try {
      const w = fs.watch(dir, { recursive }, () => fire('fs'));
      // フォルダごと消された場合などにエラーが飛ぶ。落とさずに握りつぶし、
      // セーフティの点検で拾い直す。
      w.on('error', () => {});
      watchers.push(w);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 監視するフォルダを差し替える。科目が増減したら呼び直す。
   * @param {Array<{dir:string, recursive?:boolean}>} targets
   */
  function setTargets(targets) {
    closeAll();
    const seen = new Set();
    for (const t of targets || []) {
      const dir = t && t.dir;
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      try { if (!fs.existsSync(dir)) continue; } catch (_) { continue; }

      const recursive = t.recursive !== false;
      // recursive 非対応の環境（一部の Linux）では、フラグを外して張り直す
      if (!watchOne(dir, recursive) && recursive) watchOne(dir, false);
    }
  }

  function start() {
    if (!safetyTimer) safetyTimer = setInterval(() => fire('safety'), SAFETY_MS);
  }

  function stop() {
    clearInterval(safetyTimer); safetyTimer = null;
    clearTimeout(debounceTimer); debounceTimer = null;
    closeAll();
  }

  /** アプリ自身の移動処理で二重に更新が走らないよう、一時的に止める */
  function pause() { paused++; }
  function resume() {
    paused = Math.max(0, paused - 1);
    if (paused === 0 && dirty) { dirty = false; fire('resume'); }
  }

  return {
    setTargets, start, stop, pause, resume,
    /** 手動同期ボタンなどから即座に走らせる */
    touch: () => fire('manual'),
    get watching() { return watchers.length; }
  };
}

module.exports = { createWatcher, DEBOUNCE_MS, SAFETY_MS };
