const STORAGE_KEY = 'newTabShortcuts';
const SHORTCUT_INDEX_KEY = 'newTabShortcutsIndex';
const SHORTCUT_ITEM_PREFIX = 'newTabShortcut:';
const FOLDER_INDEX_PREFIX = 'newTabFolderIndex:';
const FOLDER_ITEM_PREFIX = 'newTabFolderItem:';
const FAVICON_CACHE_PREFIX = 'faviconCache:v2:';
const FAVICON_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const FAVICON_DB_NAME = 'turbogoogle-favicons';
const FAVICON_DB_VERSION = 1;
const grid = document.querySelector('#shortcut-grid');
const dialog = document.querySelector('#shortcut-dialog');
const form = document.querySelector('#shortcut-form');
const nameInput = document.querySelector('#shortcut-name');
const urlInput = document.querySelector('#shortcut-url');
const formError = document.querySelector('#form-error');
const settingsDialog = document.querySelector('#settings-dialog');
const settingsForm = document.querySelector('#settings-form');
const brandTextInput = document.querySelector('#brand-text');
const brandColorInput = document.querySelector('#brand-color');
const backgroundColorInput = document.querySelector('#background-color');
const themeToggle = document.querySelector('#theme-toggle');
const animationToggle = document.querySelector('#animation-toggle');
const showLogoInput = document.querySelector('#show-logo');
const languageSelect = document.querySelector('#language-select');
const iconScaleInput = document.querySelector('#icon-scale');
const iconScaleValue = document.querySelector('#icon-scale-value');
const themeLabel = document.querySelector('#theme-label');
const toast = document.querySelector('#toast');
const folderDialog = document.querySelector('#folder-dialog');
const folderForm = document.querySelector('#folder-form');
const folderNameInput = document.querySelector('#folder-name');
const folderPopover = document.querySelector('#folder-popover');
const folderItems = document.querySelector('#folder-items');
const folderPopoverTitle = document.querySelector('#folder-popover-title');
let toastTimer;
let editingIndex = null;
let pendingSlot = null;
let editingFolderIndex = null;
let editingInnerId = null;
let hoverTimer = null;
let hoverTargetIndex = null;
let draggedIndex = null;
let localeMessages = {};
const faviconMemoryCache = new Map();
const faviconPendingRequests = new Map();
let faviconDbPromise = null;
const faviconQueue = [];
let activeFaviconRequests = 0;
let shortcutWriteQueue = Promise.resolve();
let renderQueue = Promise.resolve();
let shortcutCache = null;
let shortcutLoadPromise = null;
let shortcutCacheVersion = 0;
const pendingOwnChanges = new Map();
let externalRefreshScheduled = false;
let startupComplete = false;
let refreshAfterDrag = false;
function expectOwnChange(key, value) {
  const expected = JSON.stringify(value);
  const values = pendingOwnChanges.get(key) || [];
  values.push(expected); pendingOwnChanges.set(key, values);
  setTimeout(() => {
    const pending = pendingOwnChanges.get(key);
    const index = pending?.indexOf(expected) ?? -1;
    if (index >= 0) { pending.splice(index, 1); if (!pending.length) pendingOwnChanges.delete(key); }
  }, 5000);
}
function consumeOwnChange(key, value) {
  const pending = pendingOwnChanges.get(key);
  const index = pending?.indexOf(JSON.stringify(value)) ?? -1;
  if (index < 0) return false;
  pending.splice(index, 1); if (!pending.length) pendingOwnChanges.delete(key);
  return true;
}
function scheduleExternalRefresh() {
  if (externalRefreshScheduled) return;
  externalRefreshScheduled = true;
  requestAnimationFrame(() => {
    externalRefreshScheduled = false;
    if (draggedIndex === null) void render(); else refreshAfterDrag = true;
  });
}
const faviconObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  entries.forEach((entry) => { if (!entry.isIntersecting) return; faviconObserver.unobserve(entry.target); void loadFaviconImage(entry.target, entry.target.dataset.faviconName, entry.target.dataset.faviconUrl); });
}, { rootMargin: '160px' }) : null;
const sharedContextMenu = document.createElement('div');
sharedContextMenu.className = 'context-menu'; sharedContextMenu.hidden = true; document.body.append(sharedContextMenu);
const contextMenuActions = new WeakMap();
let activeContextButton = null;

const msg = (key, substitutions) => {
  const entry = localeMessages[key];
  if (entry?.message) {
    let message = entry.message;
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    Object.keys(entry.placeholders || {}).forEach((name, index) => { message = message.replaceAll(`$${name}$`, values[index] ?? ''); });
    return message;
  }
  return chrome.i18n.getMessage(key, substitutions) || ({ storageLimit: 'Chrome Sync storage limit reached' }[key] || key);
};
async function loadLocale() {
  const settings = await readSettings();
  const browserLocale = (chrome.i18n.getUILanguage() || 'it').toLowerCase().split('-')[0];
  const supportedLocales = ['it', 'en', 'es', 'id', 'pt', 'de', 'nl', 'zh', 'ko', 'ja', 'hi', 'ru', 'fr', 'tr', 'pl', 'uk'];
  const locale = settings.language === 'auto' ? (supportedLocales.includes(browserLocale) ? browserLocale : 'en') : (supportedLocales.includes(settings.language) ? settings.language : 'en');
  try { localeMessages = await fetch(`_locales/${locale}/messages.json`).then((response) => response.json()); } catch { localeMessages = {}; }
}
function localize() {
  document.title = msg('newTabTitle');
  document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = msg(element.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach((element) => { element.setAttribute('aria-label', msg(element.dataset.i18nAria)); });
  document.querySelectorAll('[data-i18n-title]').forEach((element) => { element.title = msg(element.dataset.i18nTitle); });
  document.querySelector('#search-input').placeholder = msg('searchPlaceholder');
}

const defaults = [
  { type: 'shortcut', id: crypto.randomUUID(), name: 'YouTube', url: 'https://www.youtube.com', slot: 0 },
  { type: 'shortcut', id: crypto.randomUUID(), name: 'Gmail', url: 'https://mail.google.com', slot: 1 },
  { type: 'shortcut', id: crypto.randomUUID(), name: 'Google Drive', url: 'https://drive.google.com', slot: 2 },
];

const SETTINGS_KEY = 'newTabSettings';

function normalizeShortcutItem(item, index) {
  if (item?.type === 'folder') {
    return {
      type: 'folder', id: item.id || crypto.randomUUID(), name: item.name || msg('folderDefaultName'),
      slot: Number.isInteger(item.slot) ? item.slot : index,
      items: Array.isArray(item.items) ? item.items.map((child) => normalizeShortcutItem(child, 0)).filter((child) => child.type === 'shortcut') : [],
    };
  }
  return { type: 'shortcut', id: item?.id || crypto.randomUUID(), name: item?.name || '', url: item?.url || '', slot: Number.isInteger(item?.slot) ? item.slot : index };
}

async function loadShortcutsFromSync() {
  const indexResult = await chrome.storage.sync.get(SHORTCUT_INDEX_KEY);
  if (Array.isArray(indexResult[SHORTCUT_INDEX_KEY])) {
    const ids = indexResult[SHORTCUT_INDEX_KEY];
    const records = await chrome.storage.sync.get(ids.map((id) => `${SHORTCUT_ITEM_PREFIX}${id}`));
    const folders = ids.map((id) => records[`${SHORTCUT_ITEM_PREFIX}${id}`]).filter((item) => item?.type === 'folder');
    const folderIndexKeys = folders.map((folder) => `${FOLDER_INDEX_PREFIX}${folder.id}`);
    const folderIndexes = folderIndexKeys.length ? await chrome.storage.sync.get(folderIndexKeys) : {};
    const childKeys = folders.flatMap((folder) => (folderIndexes[`${FOLDER_INDEX_PREFIX}${folder.id}`] || []).map((id) => `${FOLDER_ITEM_PREFIX}${folder.id}:${id}`));
    const children = childKeys.length ? await chrome.storage.sync.get(childKeys) : {};
    return ids.map((id, index) => {
      const record = records[`${SHORTCUT_ITEM_PREFIX}${id}`];
      if (!record) return null;
      if (record.type === 'folder') {
        const items = (folderIndexes[`${FOLDER_INDEX_PREFIX}${record.id}`] || []).map((childId) => children[`${FOLDER_ITEM_PREFIX}${record.id}:${childId}`]).filter(Boolean).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0)).map((child, childIndex) => normalizeShortcutItem(child, childIndex));
        return normalizeShortcutItem({ ...record, items }, index);
      }
      return normalizeShortcutItem(record, index);
    }).filter(Boolean);
  }
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const items = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : defaults;
  return items.map(normalizeShortcutItem);
}

async function readShortcuts() {
  if (shortcutCache) return structuredClone(shortcutCache);
  if (!shortcutLoadPromise) {
    const load = (async () => {
      let version; let items;
      do { version = shortcutCacheVersion; items = await loadShortcutsFromSync(); } while (version !== shortcutCacheVersion);
      shortcutCache = structuredClone(items);
      return structuredClone(items);
    })();
    shortcutLoadPromise = load.finally(() => { shortcutLoadPromise = null; });
  }
  return structuredClone(await shortcutLoadPromise);
}

function invalidateShortcutCache() {
  shortcutCache = null;
  shortcutCacheVersion += 1;
}

async function saveShortcuts(items) {
  const write = async () => {
    const cacheVersionAtStart = shortcutCacheVersion;
    const ordered = [...items].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
    const payload = { [SHORTCUT_INDEX_KEY]: ordered.map((item) => item.id) };
    const keepKeys = new Set([SHORTCUT_INDEX_KEY]);
    const previousIndex = await chrome.storage.sync.get(SHORTCUT_INDEX_KEY);
    const previousIds = Array.isArray(previousIndex[SHORTCUT_INDEX_KEY]) ? previousIndex[SHORTCUT_INDEX_KEY] : [];
    const previousFolderIndexKeys = previousIds.map((id) => `${SHORTCUT_ITEM_PREFIX}${id}`);
    const previousRecords = previousFolderIndexKeys.length ? await chrome.storage.sync.get(previousFolderIndexKeys) : {};
    const previousFolders = previousIds.map((id) => previousRecords[`${SHORTCUT_ITEM_PREFIX}${id}`]).filter((item) => item?.type === 'folder');
    const previousFolderIndexes = previousFolders.length ? await chrome.storage.sync.get(previousFolders.map((folder) => `${FOLDER_INDEX_PREFIX}${folder.id}`)) : {};
    ordered.forEach((item) => {
      const itemKey = `${SHORTCUT_ITEM_PREFIX}${item.id}`; keepKeys.add(itemKey);
      if (item.type === 'folder') {
        const children = (item.items || []).map((child, index) => normalizeShortcutItem(child, index));
        payload[itemKey] = { type: 'folder', id: item.id, name: item.name, slot: item.slot };
        const folderIndexKey = `${FOLDER_INDEX_PREFIX}${item.id}`; keepKeys.add(folderIndexKey); payload[folderIndexKey] = children.map((child) => child.id);
        children.forEach((child, childIndex) => { const childKey = `${FOLDER_ITEM_PREFIX}${item.id}:${child.id}`; keepKeys.add(childKey); payload[childKey] = { ...child, slot: childIndex }; });
      } else payload[itemKey] = normalizeShortcutItem(item, item.slot);
    });
    const readKeys = [...new Set([...Object.keys(payload), ...previousIds.map((id) => `${SHORTCUT_ITEM_PREFIX}${id}`), ...previousFolders.flatMap((folder) => {
      const index = previousFolderIndexes[`${FOLDER_INDEX_PREFIX}${folder.id}`] || [];
      return [`${FOLDER_INDEX_PREFIX}${folder.id}`, ...index.map((id) => `${FOLDER_ITEM_PREFIX}${folder.id}:${id}`)];
    }), STORAGE_KEY])];
    const existing = await chrome.storage.sync.get(readKeys);
    const changed = Object.fromEntries(Object.entries(payload).filter(([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value)));
    try {
      if (Object.keys(changed).length) {
        Object.entries(changed).forEach(([key, value]) => expectOwnChange(key, value));
        await chrome.storage.sync.set(changed);
      }
    } catch { invalidateShortcutCache(); showToast(msg('storageLimit')); return false; }
    const stale = readKeys.filter((key) => (key === STORAGE_KEY || key.startsWith(SHORTCUT_ITEM_PREFIX) || key.startsWith(FOLDER_INDEX_PREFIX) || key.startsWith(FOLDER_ITEM_PREFIX)) && !keepKeys.has(key));
    if (stale.length) { try { stale.forEach((key) => expectOwnChange(key, undefined)); await chrome.storage.sync.remove(stale); } catch { /* stale records are harmless and can be removed on a later save */ } }
    if (cacheVersionAtStart === shortcutCacheVersion) shortcutCache = structuredClone(items);
    return true;
  };
  const next = shortcutWriteQueue.then(write, write); shortcutWriteQueue = next.catch(() => {}); return next;
}

function fallbackIcon(name, url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = ''; }
  const key = host || name || 'shortcut';
  const palette = ['#4285f4', '#34a853', '#ea4335', '#fbbc04', '#8ab4f8', '#a142f4', '#00a884'];
  let hash = 0; for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const color = palette[hash % palette.length];
  const letter = (host || url || name || '•').charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${color}"/><text x="32" y="43" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="31" font-weight="700" fill="#fff">${letter}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function faviconFor(url) {
  try {
    const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
    faviconUrl.searchParams.set('pageUrl', url);
    faviconUrl.searchParams.set('size', '128');
    return faviconUrl.toString();
  } catch { return ''; }
}

function normalizeFaviconUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch { return ''; }
}

function faviconCacheKey(url) {
  let hash = 2166136261;
  for (const character of url) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${FAVICON_CACHE_PREFIX}${(hash >>> 0).toString(16)}`;
}

function openFaviconDb() {
  if (faviconDbPromise) return faviconDbPromise;
  faviconDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(FAVICON_DB_NAME, FAVICON_DB_VERSION);
    request.addEventListener('upgradeneeded', () => request.result.createObjectStore('favicons', { keyPath: 'url' }));
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
  return faviconDbPromise;
}

async function readFaviconDb(url) {
  const db = await openFaviconDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction('favicons', 'readonly').objectStore('favicons').get(url);
    request.addEventListener('success', () => resolve(request.result || null));
    request.addEventListener('error', () => reject(request.error));
  });
}

async function writeFaviconDb(record) {
  const db = await openFaviconDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction('favicons', 'readwrite').objectStore('favicons').put(record);
    request.addEventListener('success', resolve);
    request.addEventListener('error', () => reject(request.error));
  });
}

async function pruneFaviconCache() {
  try {
    const db = await openFaviconDb();
    const cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000);
    await new Promise((resolve, reject) => {
      const request = db.transaction('favicons', 'readwrite').objectStore('favicons').openCursor();
      request.addEventListener('error', () => reject(request.error));
      request.addEventListener('success', () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        if (!cursor.value?.savedAt || cursor.value.savedAt < cutoff) cursor.delete();
        cursor.continue();
      });
    });
  } catch { /* favicon cache is optional */ }
}

async function migrateLegacyFavicon(url) {
  try {
    const key = `${FAVICON_CACHE_PREFIX}${faviconCacheKey(url).split(':').pop()}`;
    const result = await chrome.storage.local.get(key);
    const cached = result[key];
    if (!cached?.dataUrl) return null;
    await writeFaviconDb(cached);
    await chrome.storage.local.remove(key);
    return cached;
  } catch { return null; }
}

async function readCachedFavicon(url) {
  const normalizedUrl = normalizeFaviconUrl(url);
  if (!normalizedUrl) return null;
  const inMemory = faviconMemoryCache.get(normalizedUrl);
  if (inMemory) return { blob: inMemory.blob, fresh: Date.now() - inMemory.savedAt < FAVICON_CACHE_TTL };
  try {
    const cached = await readFaviconDb(normalizedUrl) || await migrateLegacyFavicon(normalizedUrl);
    if (!cached) return null;
    const blob = cached.blob || (cached.dataUrl ? await fetch(cached.dataUrl).then((response) => response.blob()) : null);
    if (!blob?.size) return null;
    const normalized = { url: normalizedUrl, blob, savedAt: cached.savedAt || Date.now() };
    if (!cached.blob) void writeFaviconDb(normalized).catch(() => {});
    faviconMemoryCache.set(normalizedUrl, normalized);
    return { blob, fresh: Date.now() - normalized.savedAt < FAVICON_CACHE_TTL };
  } catch { return null; }
}

async function saveCachedFavicon(url, blob) {
  const normalizedUrl = normalizeFaviconUrl(url);
  if (!normalizedUrl || !blob?.size) return;
  const cached = { url: normalizedUrl, blob, savedAt: Date.now() };
  faviconMemoryCache.set(normalizedUrl, cached);
  try { await writeFaviconDb(cached); } catch { /* fallback icon remains available if the local cache cannot be written */ }
}

function enqueueFaviconRequest(task) {
  return new Promise((resolve, reject) => {
    faviconQueue.push({ task, resolve, reject });
    drainFaviconQueue();
  });
}

function drainFaviconQueue() {
  while (activeFaviconRequests < 6 && faviconQueue.length) {
    const request = faviconQueue.shift(); activeFaviconRequests += 1;
    request.task().then(request.resolve, request.reject).finally(() => { activeFaviconRequests -= 1; drainFaviconQueue(); });
  }
}

async function refreshFavicon(url) {
  const normalizedUrl = normalizeFaviconUrl(url);
  if (!normalizedUrl) return '';
  const pending = faviconPendingRequests.get(normalizedUrl);
  if (pending) return pending;
  const request = enqueueFaviconRequest(async () => {
    let lastError;
    for (const delay of [0, 1200, 4000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const response = await fetch(faviconFor(normalizedUrl), { cache: 'no-store' });
        if (!response.ok) throw new Error(`Favicon request failed: ${response.status}`);
        const blob = await response.blob();
        if (!blob.size || !blob.type.startsWith('image/')) throw new Error('Favicon response is not an image');
        await saveCachedFavicon(normalizedUrl, blob);
        return blob;
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('Favicon unavailable');
  })().finally(() => faviconPendingRequests.delete(normalizedUrl));
  faviconPendingRequests.set(normalizedUrl, request);
  return request;
}

async function getFaviconBlob(url) {
  const cached = await readCachedFavicon(url);
  if (cached?.blob) {
    if (!cached.fresh) void refreshFavicon(url).catch(() => {});
    return cached.blob;
  }
  return refreshFavicon(url);
}

async function readSettings() {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  return { brand: 'TurboGoogle', brandColor: '#f1f3f4', backgroundColor: '#202124', theme: 'dark', animation: true, showLogo: true, language: 'auto', iconScale: 1, ...(result[SETTINGS_KEY] || {}) };
}

function createWaveText(text, className = '') {
  const wrapper = document.createElement('span');
  wrapper.className = `brand-wave ${className}`.trim();
  const characters = Intl.Segmenter ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment) : Array.from(text);
  characters.forEach((character, index) => {
    if (/^\s+$/u.test(character)) { wrapper.append(document.createTextNode(character)); return; }
    const letter = document.createElement('span');
    letter.textContent = character;
    letter.style.setProperty('--wave-index', String(index % 10));
    wrapper.append(letter);
  });
  return wrapper;
}

async function applySettings(settings = null) {
  settings ||= await readSettings(); const brandElement = document.querySelector('.brand');
  document.querySelector('.brand-logo').hidden = settings.showLogo === false;
  const scale = Math.min(1.1, Math.max(0.75, Number(settings.iconScale) || 1));
  iconScaleInput.value = String(scale);
  iconScaleValue.value = `${Math.round(scale * 100)}%`;
  document.documentElement.style.setProperty('--shortcut-icon-size', `${48 * scale}px`);
  document.documentElement.style.setProperty('--shortcut-favicon-size', `${28 * scale}px`);
  document.documentElement.style.setProperty('--add-icon-size', `${48 * scale}px`);
  brandElement.classList.toggle('google-default', settings.brand === 'Google');
  brandElement.classList.toggle('animated', settings.animation !== false && settings.brand !== 'Google');
  brandElement.setAttribute('aria-label', settings.brand);
  if (settings.brand === 'TurboGoogle') {
    const google = document.createElement('span'); google.className = 'brand-google'; google.textContent = 'Google';
    brandElement.replaceChildren(createWaveText('Turbo', 'brand-turbo'), google);
  } else if (settings.brand === 'Google' || !settings.brand) brandElement.textContent = settings.brand;
  else brandElement.replaceChildren(createWaveText(settings.brand));
  const brandColor = settings.theme === 'light' && settings.brandColor === '#f1f3f4' ? '#202124' : settings.brandColor;
  brandElement.style.color = settings.brand === 'TurboGoogle' ? '' : brandColor; document.documentElement.dataset.theme = settings.theme; document.documentElement.style.setProperty('--surface', settings.backgroundColor || (settings.theme === 'light' ? '#f8f9fa' : '#202124'));
}

function showToast(message = 'Modifica salvata') {
  toast.textContent = message; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 1800);
}

async function persistSettings(message) {
  const value = { brand: brandTextInput.value.trim(), brandColor: brandColorInput.value, backgroundColor: backgroundColorInput.value, theme: themeToggle.checked ? 'light' : 'dark', animation: animationToggle.checked, showLogo: showLogoInput.checked, language: languageSelect.value, iconScale: Number(iconScaleInput.value) };
  expectOwnChange(SETTINGS_KEY, value);
  try { await chrome.storage.sync.set({ [SETTINGS_KEY]: value }); } catch { showToast(msg('storageLimit')); return; }
  await applySettings(); showToast(message);
}

async function loadFaviconImage(image, name, url) {
  if (image.dataset.faviconLoaded === 'true') return;
  image.dataset.faviconLoaded = 'true';
  const fallback = fallbackIcon(name, url);
  try {
    const blob = await getFaviconBlob(url);
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    image.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true });
    image.src = objectUrl;
  } catch { image.src = fallback; }
}

function createFavicon(item) {
  const image = document.createElement('img'); const fallback = fallbackIcon(item.name, item.url); image.alt = ''; image.loading = 'lazy'; image.src = fallback;
  image.dataset.faviconName = item.name || '';
  image.dataset.faviconUrl = item.url || '';
  image.addEventListener('error', () => { image.src = fallback; }, { once: true });
  if (faviconObserver) faviconObserver.observe(image); else void loadFaviconImage(image, item.name, item.url);
  return image;
}

function createAddButton() {
  const button = document.createElement('button');
  button.className = 'add-shortcut'; button.id = 'add-shortcut'; button.type = 'button';
  button.setAttribute('aria-label', msg('addShortcut')); button.title = msg('addShortcutTitle');
  button.innerHTML = `<span class="add-icon" aria-hidden="true">+</span><span>${msg('addShortcut')}</span>`;
  button.addEventListener('click', () => openAddDialog());
  return button;
}

function openContextMenu(button, entries) {
  const rect = button.getBoundingClientRect(); const width = 160;
  activeContextButton = button; sharedContextMenu.replaceChildren();
  entries.forEach(([label], index) => { const item = document.createElement('button'); item.type = 'button'; item.dataset.actionIndex = String(index); item.textContent = label; sharedContextMenu.append(item); });
  const host = button.closest('dialog') || document.body;
  if (sharedContextMenu.parentElement !== host) host.append(sharedContextMenu);
  sharedContextMenu.hidden = false; sharedContextMenu.style.top = `${Math.min(window.innerHeight - 120, rect.bottom + 4)}px`; sharedContextMenu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
}

function createMenu(button, entries, host = document.body) {
  button.draggable = false;
  contextMenuActions.set(button, entries);
}

function createShortcutView(item, onEdit, onDelete, compact = false, onMoveOutside = null, menuHost = document.body) {
  const link = document.createElement('a'); link.className = `shortcut${compact ? ' folder-shortcut' : ''}`; link.href = item.url; link.draggable = !compact; link.title = msg('shortcutTitle', item.name);
  const icon = document.createElement('span'); icon.className = 'shortcut-icon'; icon.append(createFavicon(item));
  const label = document.createElement('span'); label.className = 'shortcut-label'; label.textContent = item.name;
  const menuButton = document.createElement('button'); menuButton.className = 'shortcut-menu'; menuButton.type = 'button'; menuButton.textContent = '⋮'; menuButton.setAttribute('aria-label', msg('editShortcutLabel', item.name));
  const menuEntries = [[msg('edit'), onEdit], [msg('delete'), onDelete]]; if (onMoveOutside) menuEntries.push([msg('moveOutsideFolder'), onMoveOutside]);
  createMenu(menuButton, menuEntries, menuHost); link.append(icon, label, menuButton); return link;
}

async function renderNow(initialItems = null) {
  const items = initialItems || await readShortcuts();
  const addButton = document.querySelector('#add-shortcut') || createAddButton(); sharedContextMenu.hidden = true; grid.replaceChildren(); const fragment = document.createDocumentFragment();
  const occupied = new Map(items.map((item, index) => [Number.isInteger(item.slot) ? item.slot : index, { item, index }]));
  const nextSlot = Math.max(0, ...occupied.keys()) + 1; const cellCount = nextSlot + 3;
  for (let slot = 0; slot < cellCount; slot += 1) {
    const cell = document.createElement('div'); cell.className = 'shortcut-cell'; const entry = occupied.get(slot);
    if (!entry) {
      if (slot !== nextSlot) { const cellAdd = addButton.cloneNode(true); cellAdd.removeAttribute('id'); cellAdd.classList.add('cell-add-shortcut'); cellAdd.addEventListener('click', () => openAddDialog(slot)); cell.append(cellAdd); }
      attachDropTarget(cell, slot, null); if (slot === nextSlot) cell.append(addButton); fragment.append(cell); continue;
    }
    const { item, index } = entry;
    if (item.type === 'folder') {
      const folder = document.createElement('div'); folder.className = 'shortcut folder'; folder.tabIndex = 0; folder.setAttribute('role', 'button'); folder.setAttribute('aria-label', msg('openFolder', item.name));
      const preview = document.createElement('span'); preview.className = 'folder-preview'; item.items.slice(0, 4).forEach((child) => { const icon = document.createElement('span'); icon.className = 'folder-preview-icon'; icon.append(createFavicon(child)); preview.append(icon); });
      const label = document.createElement('span'); label.className = 'shortcut-label'; label.textContent = item.name;
      const menuButton = document.createElement('button'); menuButton.className = 'shortcut-menu'; menuButton.type = 'button'; menuButton.textContent = '⋮'; menuButton.setAttribute('aria-label', msg('editFolderLabel', item.name));
      const menu = createMenu(menuButton, [[msg('edit'), () => openFolderEdit(item.id)], [msg('delete'), () => deleteFolder(item.id)], [msg('separateFolder'), () => separateFolder(item.id)]]);
      folder.draggable = true; folder.addEventListener('dragstart', (event) => startDrag(event, index, folder)); folder.addEventListener('dragend', endDrag); folder.append(preview, label, menuButton); folder.addEventListener('click', (event) => { if (!event.target.closest('button')) openFolder(item.id); }); folder.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFolder(item.id); } }); cell.append(folder); attachDropTarget(cell, slot, entry);
    } else {
      const link = createShortcutView(item, () => openEdit(index), () => removeShortcut(index)); link.dataset.index = index; link.addEventListener('dragstart', (event) => startDrag(event, index, link)); link.addEventListener('dragend', endDrag); cell.append(link); attachDropTarget(cell, slot, entry);
    }
    fragment.append(cell);
  }
  grid.append(fragment);
}

function render(initialItems = null) {
  const next = renderQueue.then(() => renderNow(initialItems));
  renderQueue = next.catch(() => {});
  return next;
}

function startDrag(event, index, element) { draggedIndex = index; element.classList.add('dragging'); grid.classList.add('drag-active'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); }
function endDrag(event) { event.currentTarget.classList.remove('dragging'); grid.classList.remove('drag-active'); clearTimeout(hoverTimer); hoverTimer = null; hoverTargetIndex = null; draggedIndex = null; document.querySelectorAll('.drop-target').forEach((item) => item.classList.remove('drop-target')); if (refreshAfterDrag) { refreshAfterDrag = false; void render(); } }
function attachDropTarget(cell, slot, entry) {
  cell.dataset.slot = String(slot);
  cell.dataset.entryIndex = entry ? String(entry.index) : '';
  cell.dataset.entryType = entry?.item?.type || '';
}

grid.addEventListener('dragover', (event) => {
  if (draggedIndex === null) return;
  const cell = event.target.closest('.shortcut-cell');
  if (!cell || !grid.contains(cell)) return;
  event.preventDefault(); cell.classList.add('drop-target');
  const targetIndex = cell.dataset.entryIndex === '' ? undefined : Number(cell.dataset.entryIndex);
  if (cell.dataset.entryType === 'folder' || targetIndex === undefined || targetIndex === draggedIndex) {
    clearTimeout(hoverTimer); hoverTimer = null; hoverTargetIndex = null; return;
  }
  if (hoverTargetIndex === targetIndex && hoverTimer) return;
  clearTimeout(hoverTimer); hoverTargetIndex = targetIndex;
  hoverTimer = setTimeout(() => { hoverTimer = null; createFolder(draggedIndex, targetIndex); }, 700);
});

grid.addEventListener('dragleave', (event) => {
  const cell = event.target.closest('.shortcut-cell');
  if (!cell || cell.contains(event.relatedTarget)) return;
  cell.classList.remove('drop-target');
  if (hoverTargetIndex !== Number(cell.dataset.entryIndex)) return;
  clearTimeout(hoverTimer); hoverTimer = null; hoverTargetIndex = null;
});

grid.addEventListener('drop', async (event) => {
  const cell = event.target.closest('.shortcut-cell');
  if (!cell || !grid.contains(cell)) return;
  event.preventDefault(); cell.classList.remove('drop-target');
  clearTimeout(hoverTimer); hoverTimer = null; hoverTargetIndex = null;
  const fromIndex = draggedIndex ?? Number(event.dataTransfer.getData('text/plain'));
  if (!Number.isInteger(fromIndex)) return;
  const items = await readShortcuts(); const moving = items[fromIndex];
  if (!moving) return;
  const targetIndex = cell.dataset.entryIndex === '' ? undefined : Number(cell.dataset.entryIndex);
  const slot = Number(cell.dataset.slot);
  if (targetIndex === undefined) { moving.slot = slot; await saveShortcuts(items); draggedIndex = null; render(); return; }
  const target = items[targetIndex];
  if (!target) return;
  if (target.type === 'folder') {
    if (moving.type !== 'shortcut') return;
    target.items.push(moving); items.splice(fromIndex, 1);
    await saveShortcuts(items.map((item, index) => ({ ...item, slot: Number.isInteger(item.slot) ? item.slot : index })));
    draggedIndex = null; render(); return;
  }
  if (fromIndex === targetIndex) return;
  const oldSlot = moving.slot; moving.slot = target.slot; target.slot = oldSlot;
  await saveShortcuts(items); render();
});

async function createFolder(sourceIndex, targetIndex) { if (sourceIndex === targetIndex) return; clearTimeout(hoverTimer); hoverTimer = null; hoverTargetIndex = null; const items = await readShortcuts(); const source = items[sourceIndex]; const target = items[targetIndex]; if (!source || !target || source.type !== 'shortcut' || target.type !== 'shortcut') return; const folder = { type: 'folder', id: crypto.randomUUID(), name: msg('folderDefaultName'), slot: target.slot, items: [source, target] }; items.splice(Math.max(sourceIndex, targetIndex), 1); items.splice(Math.min(sourceIndex, targetIndex), 1, folder); await saveShortcuts(items); render(); showToast(msg('folderCreated')); }

async function openFolder(folderId) { const items = await readShortcuts(); const folderIndex = items.findIndex((item) => item.id === folderId); const folder = items[folderIndex]; if (!folder || folder.type !== 'folder') return; folderPopoverTitle.textContent = folder.name; folderItems.replaceChildren(); folder.items.forEach((item) => folderItems.append(createShortcutView(item, () => openInnerEdit(folderId, item.id), () => removeInnerShortcut(folderId, item.id), true, () => moveOutsideFolder(folderId, item.id), folderPopover))); folderPopover.showModal(); }
async function openInnerEdit(folderId, itemId) { const items = await readShortcuts(); const folderIndex = items.findIndex((item) => item.id === folderId); const folder = items[folderIndex]; const item = folder?.items.find((child) => child.id === itemId); if (!item) return; editingIndex = folderIndex; editingInnerId = itemId; pendingSlot = null; nameInput.value = item.name; urlInput.value = item.url; formError.textContent = ''; document.querySelector('#dialog-title').textContent = msg('editShortcutDialog'); dialog.showModal(); }
async function removeInnerShortcut(folderId, itemId) { const items = await readShortcuts(); const folderIndex = items.findIndex((item) => item.id === folderId); const folder = items[folderIndex]; if (!folder) return; folder.items = folder.items.filter((item) => item.id !== itemId); await saveShortcuts(items); openFolder(folderId); render(); }
async function moveOutsideFolder(folderId, itemId) { const items = await readShortcuts(); const folderIndex = items.findIndex((item) => item.id === folderId); const folder = items[folderIndex]; if (!folder || folder.type !== 'folder') return; const childIndex = folder.items.findIndex((item) => item.id === itemId); if (childIndex < 0) return; const [child] = folder.items.splice(childIndex, 1); const folderSlot = folder.slot; const moved = { ...child, type: 'shortcut', slot: folderSlot }; items.splice(folderIndex, 0, moved); folder.slot += 1; items.forEach((item) => { if (item !== moved && item !== folder && item.slot >= folder.slot) item.slot += 1; }); await saveShortcuts(items); folderPopover.close(); render(); showToast(msg('movedOutsideFolder')); }
async function openFolderEdit(folderId) { const items = await readShortcuts(); editingFolderIndex = items.findIndex((item) => item.id === folderId); folderNameInput.value = items[editingFolderIndex]?.name || ''; folderDialog.showModal(); folderNameInput.focus(); }
async function deleteFolder(folderId) { if (!confirm(msg('confirmDeleteFolder'))) return; const items = await readShortcuts(); const index = items.findIndex((item) => item.id === folderId); if (index < 0) return; items.splice(index, 1); await saveShortcuts(items); folderPopover.close(); render(); showToast(msg('folderDeleted')); }
async function separateFolder(folderId) { const items = await readShortcuts(); const ordered = [...items].sort((a, b) => a.slot - b.slot); const index = ordered.findIndex((item) => item.id === folderId); const folder = ordered[index]; if (!folder || folder.type !== 'folder') return; const expanded = [...ordered.slice(0, index), ...folder.items, ...ordered.slice(index + 1)].map((item, position) => ({ ...item, slot: position })); await saveShortcuts(expanded); folderPopover.close(); render(); showToast(msg('folderSeparated')); }

async function removeShortcut(index) {
  const shortcuts = await readShortcuts(); shortcuts.splice(index, 1); await saveShortcuts(shortcuts.map((item, slot) => ({ ...item, slot: Number.isInteger(item.slot) ? item.slot : slot }))); render();
}

async function openEdit(index) {
  const shortcut = (await readShortcuts())[index]; editingIndex = index; editingInnerId = null; pendingSlot = null; nameInput.value = shortcut.name; urlInput.value = shortcut.url; formError.textContent = ''; document.querySelector('#dialog-title').textContent = msg('editShortcutDialog'); dialog.showModal(); nameInput.focus();
}

function openAddDialog(slot = null) { pendingSlot = slot; editingIndex = null; editingInnerId = null; form.reset(); formError.textContent = ''; document.querySelector('#dialog-title').textContent = msg('addShortcutDialog'); dialog.showModal(); nameInput.focus(); }
document.querySelector('#add-shortcut').addEventListener('click', () => openAddDialog());
document.querySelector('#cancel-dialog').addEventListener('click', () => dialog.close());
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
document.querySelector('#cancel-folder-dialog').addEventListener('click', () => folderDialog.close());
document.querySelector('#close-folder-dialog').addEventListener('click', () => folderDialog.close());
folderDialog.addEventListener('click', (event) => { if (event.target === folderDialog) folderDialog.close(); });
folderForm.addEventListener('submit', async (event) => { event.preventDefault(); const items = await readShortcuts(); if (items[editingFolderIndex]) items[editingFolderIndex].name = folderNameInput.value.trim() || msg('folderDefaultName'); await saveShortcuts(items); folderDialog.close(); render(); showToast(msg('folderRenamed')); });
document.querySelector('#close-folder-popover').addEventListener('click', () => folderPopover.close());
folderPopover.addEventListener('click', (event) => { if (event.target === folderPopover) folderPopover.close(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && folderPopover.open) folderPopover.close(); });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  let url = urlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try { url = new URL(url).href; } catch { formError.textContent = msg('invalidUrl'); return; }
  const shortcuts = await readShortcuts();
  if (editingInnerId) { const item = shortcuts[editingIndex]?.items.find((child) => child.id === editingInnerId); if (item) { item.name = nameInput.value.trim(); item.url = url; } } else { const nextSlot = Math.max(-1, ...shortcuts.map((item, index) => Number.isInteger(item.slot) ? item.slot : index)) + 1; const value = { type: 'shortcut', id: crypto.randomUUID(), name: nameInput.value.trim(), url, slot: editingIndex === null ? (pendingSlot ?? nextSlot) : shortcuts[editingIndex].slot }; if (editingIndex === null) shortcuts.push(value); else shortcuts[editingIndex] = value; }
  pendingSlot = null; editingInnerId = null; await saveShortcuts(shortcuts); dialog.close(); render();
});

document.querySelector('#search-form').addEventListener('submit', (event) => {
  event.preventDefault(); const query = document.querySelector('#search-input').value.trim(); if (query) location.href = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
});

sharedContextMenu.addEventListener('click', (event) => {
  const actionButton = event.target.closest('[data-action-index]');
  if (!actionButton || !activeContextButton) return;
  event.preventDefault(); event.stopPropagation();
  const entries = contextMenuActions.get(activeContextButton); const action = entries?.[Number(actionButton.dataset.actionIndex)]?.[1];
  sharedContextMenu.hidden = true; activeContextButton = null; if (action) void action();
});
document.addEventListener('click', (event) => {
  const shortcutMenu = event.target.closest('.shortcut-menu');
  if (shortcutMenu) { event.preventDefault(); event.stopPropagation(); sharedContextMenu.hidden = true; openContextMenu(shortcutMenu, contextMenuActions.get(shortcutMenu) || []); return; }
  if (event.target.closest('.context-menu')) return;
  sharedContextMenu.hidden = true; activeContextButton = null;
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  const changedKeys = Object.entries(changes).filter(([key, change]) => !consumeOwnChange(key, change.newValue)).map(([key]) => key);
  if (changedKeys.some((key) => key === SHORTCUT_INDEX_KEY || key === STORAGE_KEY || key.startsWith(SHORTCUT_ITEM_PREFIX) || key.startsWith(FOLDER_INDEX_PREFIX) || key.startsWith(FOLDER_ITEM_PREFIX))) {
    invalidateShortcutCache();
    if (startupComplete) scheduleExternalRefresh();
  }
  if (changedKeys.includes(SETTINGS_KEY) && startupComplete) void applySettings(changes[SETTINGS_KEY].newValue);
});
const palettes = { espresso: { brandColor: '#f5e6c8', backgroundColor: '#2b2118', theme: 'dark' }, sage: { brandColor: '#f3ead8', backgroundColor: '#3b4636', theme: 'dark' }, panna: { brandColor: '#3a3027', backgroundColor: '#f4efe3', theme: 'light' } };
document.querySelector('#open-settings').addEventListener('click', async () => { const settings = await readSettings(); brandTextInput.value = settings.brand; brandColorInput.value = settings.brandColor; backgroundColorInput.value = settings.backgroundColor; themeToggle.checked = settings.theme === 'light'; animationToggle.checked = settings.animation !== false; showLogoInput.checked = settings.showLogo !== false; languageSelect.value = settings.language || 'auto'; iconScaleInput.value = String(settings.iconScale ?? 1); iconScaleValue.value = `${Math.round(Number(iconScaleInput.value) * 100)}%`; themeLabel.textContent = msg(themeToggle.checked ? 'light' : 'dark'); settingsDialog.showModal(); });
document.querySelector('#cancel-settings').addEventListener('click', () => settingsDialog.close());
document.querySelector('#close-settings').addEventListener('click', () => settingsDialog.close());
document.querySelector('#reset-brand').addEventListener('click', () => { brandTextInput.value = 'TurboGoogle'; brandColorInput.value = '#f1f3f4'; backgroundColorInput.value = '#202124'; themeToggle.checked = false; animationToggle.checked = true; showLogoInput.checked = true; languageSelect.value = 'auto'; iconScaleInput.value = '1'; iconScaleValue.value = '100%'; themeLabel.textContent = msg('dark'); void persistSettings(msg('restored')); });
document.querySelector('#use-google-brand').addEventListener('click', () => { brandTextInput.value = 'Google'; brandColorInput.value = '#f1f3f4'; void persistSettings(msg('savedText')); });
backgroundColorInput.addEventListener('input', () => void persistSettings(msg('saved')));
document.querySelectorAll('[data-palette]').forEach((button) => button.addEventListener('click', () => { const palette = palettes[button.dataset.palette]; brandColorInput.value = palette.brandColor; backgroundColorInput.value = palette.backgroundColor; themeToggle.checked = palette.theme === 'light'; themeLabel.textContent = msg(themeToggle.checked ? 'light' : 'dark'); void persistSettings(msg('saved')); }));
settingsDialog.addEventListener('click', (event) => { if (event.target === settingsDialog) settingsDialog.close(); });
brandTextInput.addEventListener('input', () => void persistSettings(msg('savedText')));
brandColorInput.addEventListener('input', () => void persistSettings(msg('savedColor')));
themeToggle.addEventListener('change', () => { themeLabel.textContent = msg(themeToggle.checked ? 'light' : 'dark'); void persistSettings(msg('savedMode', themeLabel.textContent)); });
animationToggle.addEventListener('change', () => { void persistSettings(msg('savedAnimation')); });
showLogoInput.addEventListener('change', () => { void persistSettings(msg('savedLogo')); });
languageSelect.addEventListener('change', async () => { await persistSettings(msg('savedLanguage')); await loadLocale(); localize(); });
iconScaleInput.addEventListener('input', () => { iconScaleValue.value = `${Math.round(Number(iconScaleInput.value) * 100)}%`; void persistSettings(msg('savedIconSize')); });

async function migrateLocalData() {
  const existing = await chrome.storage.sync.get([STORAGE_KEY, SETTINGS_KEY]);
  const legacyShortcuts = localStorage.getItem(STORAGE_KEY);
  const legacySettings = localStorage.getItem(SETTINGS_KEY);
  const updates = {};
  if (existing[STORAGE_KEY] === undefined && legacyShortcuts) { try { updates[STORAGE_KEY] = JSON.parse(legacyShortcuts); } catch {} }
  if (existing[SETTINGS_KEY] === undefined && legacySettings) { try { updates[SETTINGS_KEY] = JSON.parse(legacySettings); } catch {} }
  if (Object.keys(updates).length) { try { await chrome.storage.sync.set(updates); } catch { /* the normalized save below will report quota failures */ } }
}

async function loadShortcutsForStartup() {
  await migrateLocalData();
  const [items, index] = await Promise.all([readShortcuts(), chrome.storage.sync.get(SHORTCUT_INDEX_KEY)]);
  if (!Array.isArray(index[SHORTCUT_INDEX_KEY])) await saveShortcuts(items);
  return items;
}

loadLocale().then(async () => {
  localize();
  const [settings, items] = await Promise.all([readSettings(), loadShortcutsForStartup()]);
  await applySettings(settings); await render(items); startupComplete = true; void pruneFaviconCache();
});
