import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorApplication } from '../../src/apps/editor/application';
import type { TrialFactory } from '../../src/apps/editor/application';
import { exportMap, newMap } from '../../src/apps/editor/model';
import { bundledCatalog as testCatalog } from '../support/content';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(prepare?: () => Promise<TrialFactory>) {
  const downloads: string[] = [];
  let started = 0,
    stopped = 0;
  const start: TrialFactory = () => {
    started++;
    return () => {
      stopped++;
    };
  };
  const app = new EditorApplication(
    testCatalog,
    [{ ...newMap(), id: 'catalog', name: 'Catalog' }],
    {
      download: (name, source) => downloads.push(name, source),
      prepareTrial: prepare ?? (() => Promise.resolve(start)),
    },
  );
  return { app, downloads, start, counts: () => ({ started, stopped }) };
}
void test('strokes commit one undo unit while cursor and tool choices leave history alone', () => {
  const { app } = fixture();
  const original = structuredClone(app.snapshot().map);
  app.cursor({ x: 5, y: 5 });
  app.selectSymmetry('both');
  app.selectHeight(4);
  assert.equal(app.snapshot().canUndo, false);
  app.beginStroke();
  app.paintAt({ x: 5, y: 5 });
  app.paintAt({ x: 8, y: 5 });
  app.finishStroke();
  assert.equal(app.snapshot().canUndo, true);
  app.undo();
  assert.deepEqual(app.snapshot().map, original);
  assert.equal(app.snapshot().canUndo, false);
  app.redo();
  assert.equal(app.snapshot().canUndo, true);
});
void test('metadata, resize, catalog replacement and spawn removal share undo and validation', () => {
  const { app, downloads } = fixture();
  app.properties({ id: 'small', name: 'Small', author: 'Test', width: 8, height: 8 });
  assert.match(app.snapshot().report.errors.join(' '), /Spawn/);
  app.save();
  assert.equal(downloads.length, 0);
  app.removeSpawn(1);
  app.save();
  assert.equal(downloads[0], 'small.json');
  assert.equal(app.dirty(), false);
  app.undo();
  assert.equal(app.dirty(), true);
  app.openCatalog('catalog');
  assert.equal(app.snapshot().map.name, 'Catalog');
  app.undo();
  assert.equal(app.snapshot().map.name, 'Small');
});
void test('stale file reads cannot overwrite a newer file, edit or disposed application', async () => {
  const { app } = fixture();
  const first = deferred<string>();
  const second = deferred<string>();
  const a = app.openFile({ name: 'a', size: 50, text: () => first.promise });
  const b = app.openFile({ name: 'b', size: 50, text: () => second.promise });
  second.resolve(exportMap({ ...newMap(), name: 'Newest' }));
  await b;
  first.resolve(exportMap({ ...newMap(), name: 'Old' }));
  await a;
  assert.equal(app.snapshot().map.name, 'Newest');
  assert.equal(app.snapshot().reading, false);
  const late = deferred<string>();
  const c = app.openFile({ name: 'c', size: 50, text: () => late.promise });
  app.newDocument();
  late.resolve(exportMap({ ...newMap(), name: 'Too late' }));
  await c;
  assert.equal(app.snapshot().map.name, 'My arena');
  const abandoned = deferred<string>();
  const d = app.openFile({ name: 'd', size: 50, text: () => abandoned.promise });
  app.dispose();
  const final = app.snapshot();
  abandoned.reject(new Error('late failure'));
  await d;
  assert.equal(app.snapshot(), final);
});
void test('invalid and oversized imports report errors and retain the previous document', async () => {
  const { app } = fixture();
  const map = app.snapshot().map;
  await app.openFile({ name: 'invalid', size: 4, text: () => Promise.resolve('oops') });
  assert.equal(app.snapshot().map, map);
  assert.match(app.snapshot().notice, /valid JSON/);
  let read = false;
  await app.openFile({
    name: 'large',
    size: 2 ** 21,
    text: () => {
      read = true;
      return Promise.resolve('');
    },
  });
  assert.equal(read, false);
  assert.match(app.snapshot().notice, /1 MiB/);
});
void test('local theme preview owns separate history and closing restores installed edits', () => {
  const { app } = fixture();
  app.cursor({ x: 6, y: 6 });
  app.paintCursor();
  const installed = app.snapshot().map;
  const theme = { ...testCatalog.themes[0]!, id: 'local-preview' };
  app.preview(theme);
  app.newDocument();
  app.undo();
  app.preview(undefined);
  assert.deepEqual(app.snapshot().map, installed);
  assert.equal(app.snapshot().content, testCatalog);
  assert.equal(app.snapshot().canUndo, true);
});
void test('trial preparation is cancelled by editing or disposal and active trials stop once', async () => {
  const loading = deferred<TrialFactory>();
  const f = fixture(() => loading.promise);
  const pending = f.app.test();
  assert.equal(f.app.snapshot().trialLoading, true);
  f.app.newDocument();
  loading.resolve(f.start);
  await pending;
  assert.deepEqual(f.counts(), { started: 0, stopped: 0 });
  assert.equal(f.app.snapshot().trialLoading, false);
  await f.app.test();
  assert.equal(f.app.snapshot().trial, true);
  f.app.endTrial();
  f.app.endTrial();
  assert.deepEqual(f.counts(), { started: 1, stopped: 1 });
  const disposed = deferred<TrialFactory>();
  const other = fixture(() => disposed.promise);
  const final = other.app.test();
  other.app.dispose();
  disposed.resolve(other.start);
  await final;
  assert.deepEqual(other.counts(), { started: 0, stopped: 0 });
});
void test('trial failures keep the document editable and do not report successful entry', async () => {
  const { app } = fixture(() => Promise.reject(new Error('WebGL unavailable')));
  await app.test();
  assert.equal(app.snapshot().trial, false);
  assert.equal(app.snapshot().trialLoading, false);
  assert.equal(app.snapshot().notice, 'WebGL unavailable');
  app.newDocument();
  assert.equal(app.snapshot().map.name, 'My arena');
});
