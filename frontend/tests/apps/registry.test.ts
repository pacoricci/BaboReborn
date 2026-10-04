import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../../src/apps/portal/registry-application';
import { serverState, releaseSummary } from '../../src/apps/portal/registry-api';
import type { Server, ServerRelease } from '../../src/apps/portal/registry-api';
import { queryScope, flushQueries } from '../support/queries';

const server: Server = {
  id: 'a'.repeat(32),
  owner: 'owner',
  role: 'owner',
  assignmentVerified: true,
  name: 'Arena',
  region: 'Europe',
  origin: 'https://arena.example',
  revision: 1,
  appliedRevision: 1,
  publicKey: 'installation',
  status: 'active',
  online: true,
  compatible: true,
  lastVerifiedAt: null,
  transferAccepted: false,
};

void test('pairing codes retain the server expiry instead of starting a new browser lifetime', async (t) => {
  const now = Date.now();
  const expiresAt = new Date(now + 120000).toISOString();
  const clock = t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) =>
    Promise.resolve(
      Response.json(
        options.method === 'GET' ? [server] : { server, code: 'private-code', expiresAt },
      ),
    ),
  );
  const { value: app } = queryScope((client) =>
    createRegistry(
      () => 'owner',
      client,
      () => true,
    ),
  );
  app.setup(server);
  await app.createForm(app.panel()!).submit();
  const form = app.createForm(app.panel()!);
  assert.deepEqual(form.saved(), { code: 'private-code', expiresAt });
  assert.equal(form.expired(), false);
  clock.mock.mockImplementation(() => now + 120000);
  assert.equal(form.expired(), true);
});

void test('pairing responses without a valid expiry are rejected', async (t) => {
  for (const expiresAt of [undefined, 'invalid']) {
    t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) =>
      Promise.resolve(
        Response.json(
          options.method === 'GET' ? [server] : { server, code: 'private-code', expiresAt },
        ),
      ),
    );
    const { value: app, dispose } = queryScope((client) =>
      createRegistry(
        () => 'owner',
        client,
        () => true,
      ),
    );
    app.setup(server);
    const form = app.createForm(app.panel()!);
    await form.submit();
    assert.equal(form.saved(), undefined);
    assert.equal(form.failed(), true);
    assert.equal(form.feedback(), 'Invalid pairing code response.');
    dispose();
  }
});

void test('registry polling preserves drafts and stale writes require reopening the editor', async (t) => {
  let current = { ...server };
  const writes: unknown[] = [];
  let discard = false;
  t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => {
    if (options.method === 'GET') return Promise.resolve(Response.json([current]));
    assert.ok(typeof options.body === 'string');
    const input = JSON.parse(options.body) as { revision: number; region: string };
    writes.push(input);
    if (input.revision !== current.revision)
      return Promise.resolve(Response.json({ error: 'stale_revision' }, { status: 409 }));
    current = { ...current, region: input.region, revision: current.revision + 1 };
    return Promise.resolve(Response.json({ server: current }));
  });
  const { value: app } = queryScope((client) =>
    createRegistry(
      () => 'owner',
      client,
      () => discard,
    ),
  );
  await flushQueries();
  app.settings(app.items()[0]!);
  const form = app.createForm(app.panel()!);
  form.setDraft('region', 'Draft Europe');
  form.changed();
  current = { ...current, region: 'Updated elsewhere', revision: 2 };
  await app.refresh();
  assert.equal(form.draft.region, 'Draft Europe');
  assert.equal(form.server()?.revision, 1);
  await form.submit();
  assert.equal(form.failed(), true);
  assert.match(form.feedback(), /changed while you were editing/);
  assert.equal(app.dirty(), true);
  app.close();
  assert.equal(app.panel()?.kind, 'settings');
  discard = true;
  app.close();
  app.settings(app.items()[0]!);
  const reopened = app.createForm(app.panel()!);
  assert.equal(reopened.draft.region, 'Updated elsewhere');
  reopened.setDraft('region', 'New Europe');
  reopened.changed();
  await reopened.submit();
  assert.equal(reopened.failed(), false);
  assert.equal(reopened.server()?.revision, 3);
  assert.equal(app.dirty(), false);
  reopened.setDraft('region', 'Next Europe');
  await reopened.submit();
  assert.deepEqual(
    writes.map((value) => (value as { revision: number }).revision),
    [1, 2, 3],
  );
});

void test('registry pending writes block duplicate submits and closing; refresh failure preserves a saved result', async (t) => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let writes = 0;
  t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => {
    if (options.method === 'GET')
      return Promise.resolve(
        writes
          ? Response.json({ error: 'storage_unavailable' }, { status: 503 })
          : Response.json([server]),
      );
    writes++;
    return pending;
  });
  const { value: app } = queryScope((client) =>
    createRegistry(
      () => 'owner',
      client,
      () => true,
    ),
  );
  await flushQueries();
  app.settings(app.items()[0]!);
  const panel = app.panel();
  const form = app.createForm(panel!);
  form.setDraft('region', 'Saved region');
  form.changed();
  const submission = form.submit();
  assert.equal(form.submit(), undefined);
  app.close();
  assert.equal(app.panel(), panel);
  await flushQueries();
  assert.equal(app.busy(), true);
  assert.equal(writes, 1);
  finish(Response.json({ server: { ...server, region: 'Saved region', revision: 2 } }));
  await submission;
  await flushQueries();
  assert.equal(app.busy(), false);
  assert.equal(form.failed(), false);
  assert.equal(form.feedback(), 'Details saved.');
  assert.equal(form.server()?.revision, 2);
  assert.equal(app.dirty(), false);
  assert.match(app.notice(), /Change saved. The list could not refresh/);
  app.close();
  assert.equal(app.panel(), undefined);
});

void test('ownership transfer writes only after the review is explicitly submitted', async (t) => {
  const writes: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, options: RequestInit) => {
    if (options.method === 'GET') return Promise.resolve(Response.json([server]));
    assert.ok(typeof options.body === 'string');
    writes.push({ url, body: JSON.parse(options.body) as unknown });
    return Promise.resolve(Response.json({ server }));
  });
  const { value: app } = queryScope((client) =>
    createRegistry(
      () => 'owner',
      client,
      () => true,
    ),
  );
  await flushQueries();
  app.settings(app.items()[0]!);
  app.createForm(app.panel()!).transfer();
  const form = app.createForm(app.panel()!);
  const recipient = 'b'.repeat(32);
  form.setDraft('account', recipient);
  form.changed();
  await form.submit();
  assert.equal(app.panel()?.kind, 'confirm');
  assert.deepEqual(writes, []);
  await app.createForm(app.panel()!).submit();
  assert.deepEqual(writes, [
    {
      url: `/api/v1/manage/servers/${server.id}/transfer`,
      body: { revision: 1, account: recipient },
    },
  ]);
  assert.equal(app.panel(), undefined);
  assert.match(app.notice(), /Ownership transfer offered/);
});

void test('release advice distinguishes optional updates, incompatibility and unknown verification', () => {
  const release: ServerRelease = {
    installed: '1.0.0',
    recommended: '2.0.0',
    status: 'update_available',
    checkedAt: '2026-10-04T10:00:00Z',
    differences: [],
    notesUrl: '',
  };
  assert.equal(serverState({ ...server, release }), 'Online · update available');
  assert.equal(serverState({ ...server, online: false, release }), 'Offline');
  assert.equal(
    serverState({ ...server, online: false, release: { ...release, status: 'update_required' } }),
    'Update required',
  );
  assert.equal(
    serverState({ ...server, online: false, release: { ...release, status: 'incompatible' } }),
    'Incompatible version',
  );
  assert.equal(serverState({ ...server, release: { ...release, status: 'unknown' } }), 'Online');
  assert.match(
    releaseSummary({ ...release, installed: '', status: 'unknown' }),
    /Installed: unknown.*Awaiting verification/,
  );
  assert.match(releaseSummary(release), /Update available/);
});
