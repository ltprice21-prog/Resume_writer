/* Remembering things across closing the app.
 *
 * Two kinds of memory, both local to this browser and this machine:
 *
 *   1. The folder you picked. A directory handle survives in IndexedDB, so
 *      reopening the file reconnects to the same OneDrive folder — at worst one
 *      click to re-grant, never navigating the picker again.
 *   2. Work in progress. Purchase orders you loaded but have not posted, with
 *      their routing and edits, so closing mid-batch costs nothing.
 *
 * Everything degrades quietly: if IndexedDB is unavailable the app behaves
 * exactly as it did before, and nothing here ever blocks startup.
 *
 * Extends the global `AMI` namespace.
 */
(function (global) {
  'use strict';

  const AMI = global.AMI || (global.AMI = {});

  const DB_NAME = 'ami-order-desk';
  const DB_VERSION = 1;
  const STORE = 'kv';

  const KEY_FOLDER = 'workspace-folder';
  const KEY_SESSION = 'session';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
      setTimeout(() => reject(new Error('IndexedDB timed out')), 4000);
    }).catch((e) => { dbPromise = null; throw e; });
    return dbPromise;
  }

  /** Whether anything can be remembered at all in this browser. */
  async function available() {
    try { await openDb(); return true; } catch (e) { return false; }
  }

  function tx(db, mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async function idbGet(key) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const req = tx(db, 'readonly').get(key);
        req.onsuccess = () => resolve(req.result == null ? null : req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) { return null; }
  }

  async function idbSet(key, value) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const req = tx(db, 'readwrite').put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      return true;
    } catch (e) { return false; }
  }

  async function idbDel(key) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const req = tx(db, 'readwrite').delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      return true;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ *
   * The folder
   * ------------------------------------------------------------------ */

  const rememberFolder = (handle, name, key) =>
    idbSet(key || KEY_FOLDER, { handle, name: name || handle.name || '', savedAt: new Date().toISOString() });

  const forgetFolder = (key) => idbDel(key || KEY_FOLDER);

  async function recallFolder(key) {
    const record = await idbGet(key || KEY_FOLDER);
    if (!record || !record.handle) return null;
    return record;
  }

  /**
   * Whether a remembered handle can be used right now.
   * `granted` means reconnect silently; `prompt` means one click from a real
   * user gesture; `denied` or a throw means forget it and ask again.
   */
  async function handlePermission(handle, request) {
    if (!handle) return 'denied';
    try {
      const opts = { mode: 'readwrite' };
      if (request) {
        if (!handle.requestPermission) return 'granted';
        return await handle.requestPermission(opts);
      }
      if (!handle.queryPermission) return 'granted';
      return await handle.queryPermission(opts);
    } catch (e) {
      return 'denied';
    }
  }

  /* ------------------------------------------------------------------ *
   * Work in progress
   * ------------------------------------------------------------------ */

  /**
   * Save unposted work. PDFs go in as ArrayBuffers, which IndexedDB stores
   * directly, so a restored order is byte-identical to the one you dropped in.
   */
  async function saveSession(session) {
    if (!session || !session.pos || !session.pos.length) return forgetSession();
    return idbSet(KEY_SESSION, Object.assign({ version: 1, savedAt: new Date().toISOString() }, session));
  }

  async function loadSession() {
    const s = await idbGet(KEY_SESSION);
    if (!s || !Array.isArray(s.pos) || !s.pos.length) return null;
    return s;
  }

  const forgetSession = () => idbDel(KEY_SESSION);

  /** Debounce autosaves so typing in a field does not write on every keystroke. */
  function debounce(fn, wait) {
    let timer = null;
    const wrapped = function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait || 500);
    };
    wrapped.flush = function () {
      if (timer) { clearTimeout(timer); timer = null; fn(); }
    };
    wrapped.cancel = function () { clearTimeout(timer); timer = null; };
    return wrapped;
  }

  function describeAge(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return '';
    const mins = Math.round((Date.now() - then.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
    const days = Math.round(hours / 24);
    return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  }

  Object.assign(AMI, {
    persistAvailable: available,
    idbGet, idbSet, idbDel,
    rememberFolder, recallFolder, forgetFolder, handlePermission,
    saveSession, loadSession, forgetSession,
    debounce, describeAge,
    PERSIST_KEY_FOLDER: KEY_FOLDER,
    PERSIST_KEY_SESSION: KEY_SESSION,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = AMI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
