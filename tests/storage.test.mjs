import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const fullSource = await readFile(new URL('../newtab.js', import.meta.url), 'utf8');
const source = [
  fullSource.split('function fallbackIcon(')[0],
  fullSource.slice(fullSource.indexOf('function faviconFor('), fullSource.indexOf('async function readSettings(')),
].join('\n');

function createHarness(initial = {}) {
  const values = structuredClone(initial);
  let reads = 0;
  const sync = {
    async get(keys) {
      reads += 1;
      const requested = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(requested.filter((key) => key in values).map((key) => [key, structuredClone(values[key])]));
    },
    async set(changes) { Object.assign(values, structuredClone(changes)); },
    async remove(keys) { keys.forEach((key) => delete values[key]); },
  };
  const context = vm.createContext({
    chrome: { storage: { sync }, runtime: { getURL: (path) => `chrome-extension://test${path}` }, i18n: { getMessage: () => 'Folder', getUILanguage: () => 'en' } },
    crypto: { randomUUID: () => 'generated-id' }, structuredClone, setTimeout,
    URL, document: { querySelector: () => ({}), createElement: () => ({ className: '', hidden: false }), body: { append() {} } },
    window: {}, requestAnimationFrame: () => {},
  });
  vm.runInContext(source, context);
  const call = (expression) => vm.runInContext(expression, context);
  return { values, call, get reads() { return reads; } };
}

test('normalizes favicon URLs and rejects unsupported protocols', () => {
  const harness = createHarness();
  assert.equal(harness.call('normalizeFaviconUrl("https://Example.com/page#section")'), 'https://example.com/page');
  assert.equal(harness.call('normalizeFaviconUrl("ftp://example.com/icon")'), '');
});

test('orders native Chrome favicon before standard site candidates', () => {
  const harness = createHarness();
  assert.deepEqual(Array.from(harness.call('faviconCandidates("https://example.com/path")')), [
    'chrome-extension://test/_favicon/?pageUrl=https%3A%2F%2Fexample.com%2Fpath&size=128',
    'https://example.com/favicon.ico',
    'https://example.com/favicon.png',
    'https://example.com/apple-touch-icon.png',
  ]);
});

test('reads legacy shortcuts once and returns independent cached copies', async () => {
  const harness = createHarness({ newTabShortcuts: [{ id: 'one', name: 'One', url: 'https://one.example', slot: 0 }] });
  const first = await harness.call('readShortcuts()');
  const readsAfterFirst = harness.reads;
  first[0].name = 'Changed only in caller';
  const second = await harness.call('readShortcuts()');
  assert.equal(harness.reads, readsAfterFirst);
  assert.equal(second[0].name, 'One');
});

test('save updates the cache and migrates legacy records', async () => {
  const harness = createHarness({ newTabShortcuts: [{ id: 'one', name: 'One', url: 'https://one.example', slot: 0 }] });
  await harness.call('readShortcuts()');
  assert.equal(await harness.call('saveShortcuts([{ type: "shortcut", id: "one", name: "Updated", url: "https://one.example", slot: 0 }])'), true);
  const readsAfterSave = harness.reads;
  assert.equal((await harness.call('readShortcuts()'))[0].name, 'Updated');
  assert.equal(harness.reads, readsAfterSave);
  assert.equal(harness.values.newTabShortcuts, undefined);
  assert.deepEqual(Array.from(harness.values.newTabShortcutsIndex), ['one']);
});

test('external invalidation loads updated sync data', async () => {
  const harness = createHarness({ newTabShortcuts: [{ id: 'one', name: 'One', url: 'https://one.example', slot: 0 }] });
  await harness.call('readShortcuts()');
  harness.values.newTabShortcuts[0].name = 'Remote update';
  harness.call('invalidateShortcutCache()');
  assert.equal((await harness.call('readShortcuts()'))[0].name, 'Remote update');
});

test('keeps the last complete shortcut snapshot during partial sync', async () => {
  const harness = createHarness({
    newTabShortcutsIndex: ['one', 'two'],
    'newTabShortcut:one': { type: 'shortcut', id: 'one', name: 'One', url: 'https://one.example', slot: 0 },
    'newTabShortcut:two': { type: 'shortcut', id: 'two', name: 'Two', url: 'https://two.example', slot: 1 },
  });
  await harness.call('readShortcuts()');
  delete harness.values['newTabShortcut:two'];
  harness.call('invalidateShortcutCache()');
  const recovered = await harness.call('readShortcuts()');
  assert.deepEqual(Array.from(recovered, (item) => item.id), ['one', 'two']);
});

test('keeps folder children during a partial sync', async () => {
  const harness = createHarness({
    newTabShortcutsIndex: ['folder'],
    'newTabShortcut:folder': { type: 'folder', id: 'folder', name: 'Folder', slot: 0 },
    'newTabFolderIndex:folder': ['child'],
    'newTabFolderItem:folder:child': { type: 'shortcut', id: 'child', name: 'Child', url: 'https://child.example', slot: 0 },
  });
  const first = await harness.call('readShortcuts()');
  assert.equal(first[0].items[0].id, 'child');
  delete harness.values['newTabFolderItem:folder:child'];
  harness.call('invalidateShortcutCache()');
  const recovered = await harness.call('readShortcuts()');
  assert.equal(recovered[0].items[0].id, 'child');
});

test('normalizes folder children and drops nested folders', async () => {
  const harness = createHarness({ newTabShortcuts: [{ type: 'folder', id: 'folder', name: 'Folder', slot: 0, items: [
    { type: 'shortcut', id: 'child', name: 'Child', url: 'https://child.example', slot: 4 },
    { type: 'folder', id: 'nested', name: 'Nested', slot: 5, items: [] },
  ] }] });
  const items = await harness.call('readShortcuts()');
  assert.deepEqual(Array.from(items[0].items, (item) => item.id), ['child']);
  assert.equal(items[0].items[0].slot, 4);
});

test('uses a locally cached remote favicon source without sync storage', async () => {
  const harness = createHarness();
  await harness.call('saveCachedFavicon("https://example.com/page", null, "https://example.com/favicon.ico")');
  const source = await harness.call('getFaviconSource("https://example.com/page")');
  assert.equal(source.sourceUrl, 'https://example.com/favicon.ico');
  assert.equal(source.fresh, true);
  assert.equal(harness.values.newTabShortcuts, undefined);
});

test('serializes folder children into dedicated sync records', async () => {
  const harness = createHarness();
  const saved = await harness.call('saveShortcuts([{ type: "folder", id: "folder", name: "Folder", slot: 0, items: [{ type: "shortcut", id: "child", name: "Child", url: "https://child.example", slot: 9 }] }])');
  assert.equal(saved, true);
  assert.deepEqual(Array.from(harness.values.newTabShortcutsIndex), ['folder']);
  assert.deepEqual(Array.from(harness.values['newTabFolderIndex:folder']), ['child']);
  assert.equal(harness.values['newTabFolderItem:folder:child'].slot, 0);
});
