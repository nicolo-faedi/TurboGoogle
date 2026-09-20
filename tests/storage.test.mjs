import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../newtab.js', import.meta.url), 'utf8')).split('function fallbackIcon(')[0];

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
    chrome: { storage: { sync }, i18n: { getMessage: () => 'Folder', getUILanguage: () => 'en' } },
    crypto: { randomUUID: () => 'generated-id' }, structuredClone, setTimeout,
    document: { querySelector: () => ({}), createElement: () => ({ className: '', hidden: false }), body: { append() {} } },
    window: {}, requestAnimationFrame: () => {},
  });
  vm.runInContext(source, context);
  const call = (expression) => vm.runInContext(expression, context);
  return { values, call, get reads() { return reads; } };
}

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
