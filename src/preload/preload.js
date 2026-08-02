'use strict';
/**
 * preload.js — レンダラーへ window.api を公開する
 * contextIsolation を有効にしたまま、必要な操作だけを渡す。
 */
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = [
  'scan:start', 'scan:progress', 'scan:done', 'file:unmatched', 'file:failed',
  // エクスプローラー側でフォルダやファイルが変わったときに飛んでくる
  'fs:changed'
];

const api = {
  app: {
    getState:        () => ipcRenderer.invoke('app:getState'),
    completeSetup:   () => ipcRenderer.invoke('app:completeSetup'),
    completeTutorial:() => ipcRenderer.invoke('app:completeTutorial')
  },
  subjects: {
    list:       () => ipcRenderer.invoke('subjects:list'),
    createMany: (names, baseFolder) => ipcRenderer.invoke('subjects:createMany', names, baseFolder),
    remove:     (subjectId) => ipcRenderer.invoke('subjects:remove', subjectId),
    /** 科目フォルダの中を実際に読んで数えた件数 */
    counts:     () => ipcRenderer.invoke('subjects:counts')
  },
  sync: {
    /** エクスプローラーの状態にアプリを合わせ直す */
    now: () => ipcRenderer.invoke('sync:now')
  },
  rules: {
    getKeywords: () => ipcRenderer.invoke('rules:getKeywords'),
    setKeyword:  (subjectId, keyword) => ipcRenderer.invoke('rules:setKeyword', subjectId, keyword)
  },
  queue: {
    list:         () => ipcRenderer.invoke('queue:list'),
    moveManually: (queueId, subjectId) => ipcRenderer.invoke('queue:moveManually', queueId, subjectId),
    removeFile:   (queueId) => ipcRenderer.invoke('queue:removeFile', queueId),
    /** デバッグ用：一覧に出ているファイルをまとめてごみ箱へ移動する */
    clearAll:     () => ipcRenderer.invoke('queue:clearAll')
  },
  history: {
    countBySubject: () => ipcRenderer.invoke('history:countBySubject'),
    /** 振り分けた履歴（新しい順）。再起動しても残る */
    list:           (limit) => ipcRenderer.invoke('history:list', limit),
    undoLast:       (n) => ipcRenderer.invoke('history:undoLast', n)
  },
  scan: {
    getStatus: () => ipcRenderer.invoke('scan:getStatus'),
    setFolder: (folder) => ipcRenderer.invoke('scan:setFolder', folder),
    runNow:    () => ipcRenderer.invoke('scan:runNow')
  },
  dialog: {
    chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder')
  },
  shell: {
    openFolder:   (folderPath) => ipcRenderer.invoke('shell:openFolder', folderPath),
    /** エクスプローラーでそのファイルを選択した状態で開く */
    showInFolder: (target) => ipcRenderer.invoke('shell:showInFolder', target)
  },
  debug: {
    explain: (queueId) => ipcRenderer.invoke('debug:explain', queueId)
  },
  /** メインプロセスからの通知を購読する。戻り値を呼ぶと解除できる。 */
  on(channel, handler) {
    if (!EVENTS.includes(channel)) throw new Error('unknown channel: ' + channel);
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
};

contextBridge.exposeInMainWorld('api', api);
