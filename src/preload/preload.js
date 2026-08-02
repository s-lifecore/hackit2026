'use strict';
/**
 * preload.js — レンダラーへ window.api を公開する
 * contextIsolation を有効にしたまま、必要な操作だけを渡す。
 */
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['scan:start', 'scan:progress', 'scan:done', 'file:unmatched', 'file:failed'];

const api = {
  app: {
    getState:        () => ipcRenderer.invoke('app:getState'),
    completeSetup:   () => ipcRenderer.invoke('app:completeSetup'),
    completeTutorial:() => ipcRenderer.invoke('app:completeTutorial')
  },
  subjects: {
    list:       () => ipcRenderer.invoke('subjects:list'),
    createMany: (names, baseFolder) => ipcRenderer.invoke('subjects:createMany', names, baseFolder),
    remove:     (subjectId) => ipcRenderer.invoke('subjects:remove', subjectId)
  },
  rules: {
    getKeywords: () => ipcRenderer.invoke('rules:getKeywords'),
    setKeyword:  (subjectId, keyword) => ipcRenderer.invoke('rules:setKeyword', subjectId, keyword)
  },
  queue: {
    list:         () => ipcRenderer.invoke('queue:list'),
    moveManually: (queueId, subjectId) => ipcRenderer.invoke('queue:moveManually', queueId, subjectId),
    removeFile:   (queueId) => ipcRenderer.invoke('queue:removeFile', queueId)
  },
  history: {
    countBySubject: () => ipcRenderer.invoke('history:countBySubject'),
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
    openFolder: (folderPath) => ipcRenderer.invoke('shell:openFolder', folderPath)
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
