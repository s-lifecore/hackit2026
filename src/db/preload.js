/**
 * preload.js — レンダラーに window.api を安全に公開する
 * =============================================================================
 * contextIsolation:true / nodeIntegration:false 前提。
 * fs も chokidar も better-sqlite3 も、ここには一切出てこない
 * （全部 main プロセス側の main-ipc.js の中）。
 *
 * チャンネル名・戻り値の形は ipc-contract.md を正としている。
 * ここを変えたら ipc-contract.md と mock-api.js も合わせて直すこと。
 * =============================================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const EVENT_NAMES = [
  'scan:start', 'scan:progress', 'scan:done',
  'file:moved', 'file:unmatched', 'file:failed',
];

contextBridge.exposeInMainWorld('api', {
  subjects: {
    list: invoke('subjects:list'),
    get: invoke('subjects:get'),
    createMany: invoke('subjects:createMany'),
    importFromFolder: invoke('subjects:importFromFolder'),
    update: invoke('subjects:update'),
    remove: invoke('subjects:remove'),
  },
  rules: {
    getKeywords: invoke('rules:getKeywords'),
    setKeyword: invoke('rules:setKeyword'),
    list: invoke('rules:list'),
    create: invoke('rules:create'),
    update: invoke('rules:update'),
    remove: invoke('rules:remove'),
  },
  aliases: {
    list: invoke('aliases:list'),
    add: invoke('aliases:add'),
  },
  /** 起動時スキャン（常時監視は廃止した） */
  scan: {
    getStatus: invoke('scan:getStatus'),   // → {folder, scanOnStartup, lastScan}
    setFolder: invoke('scan:setFolder'),
    runNow: invoke('scan:runNow'),         // ユーザーが「今すぐ確認」を押したとき
    setOnStartup: invoke('scan:setOnStartup'),
    history: invoke('scan:history'),
  },

  /** OSのログイン時に自動起動するかどうか */
  startup: {
    get: invoke('startup:get'),
    set: invoke('startup:set'),
  },

  /** エクスプローラー等でフォルダを開く */
  shell: {
    openFolder: invoke('shell:openFolder'),
    revealFile: invoke('shell:revealFile'),
  },

  /** 初回起動か／セットアップ済みか */
  app: {
    getState: invoke('app:getState'),      // → {setupCompleted, subjectCount}
    completeSetup: invoke('app:completeSetup'),
  },
  queue: {
    list: invoke('queue:list'),
    processAll: invoke('queue:processAll'),
    moveManually: invoke('queue:moveManually'),
    countByStatus: invoke('queue:countByStatus'),
  },
  history: {
    list: invoke('history:list'),
    stats: invoke('history:stats'),
    undo: invoke('history:undo'),
    undoLast: invoke('history:undoLast'),
    countBySubject: invoke('history:countBySubject'),
  },
  settings: {
    get: invoke('settings:get'),
    set: invoke('settings:set'),
    getAll: invoke('settings:getAll'),
  },
  dialog: {
    chooseFolder: invoke('dialog:chooseFolder'),
  },

  /** main → renderer のイベント購読 */
  on(eventName, callback) {
    if (!EVENT_NAMES.includes(eventName)) {
      throw new Error(`未知のイベント名: ${eventName}`);
    }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(eventName, listener);
    // off() で外せるように、渡された callback と実リスナーの対応を覚えておく
    if (!callback.__ipcListener) callback.__ipcListener = new Map();
    callback.__ipcListener.set(eventName, listener);
  },
  off(eventName, callback) {
    const listener = callback.__ipcListener?.get(eventName);
    if (listener) ipcRenderer.removeListener(eventName, listener);
  },
});
