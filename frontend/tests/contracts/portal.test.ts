import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveServer, serverURL } from '../../src/network/context';
import { guestIdentity, initializeIdentity, serverAPI } from '../../src/network/identity';

void test('portal resolves registered destinations and sends proofs only to that server', async (t) => {
  const id = 'a'.repeat(32);
  const calls: { url: string; options: RequestInit | undefined }[] = [];
  t.mock.method(globalThis, 'fetch', (input: string | URL, options?: RequestInit) => {
    const url = String(input);
    calls.push({ url, options });
    if (url.startsWith('/api/v1/manage/servers/'))
      return Promise.resolve(
        Response.json({
          id,
          name: 'A',
          origin: 'https://a.example',
          publicKey: 'x'.repeat(43),
          online: true,
          compatible: true,
        }),
      );
    if (url === '/api/v1/account')
      return Promise.resolve(
        Response.json({ account: 'account', expired: false, loginAvailable: true }),
      );
    if (url === '/identity/v1/access')
      return Promise.resolve(
        Response.json({
          proof: 'memory-only-proof',
          expiresAt: new Date(Date.now() + 900000).toISOString(),
        }),
      );
    return Promise.resolve(Response.json({ ok: true }));
  });
  await resolveServer(new URL(`https://portal.example/manage/servers/${id}`));
  await initializeIdentity();
  await serverAPI('/api/v1/me');
  const last = calls.at(-1)!;
  assert.equal(last.url, 'https://a.example/api/v1/me');
  assert.equal(last.options?.credentials, 'omit');
  assert.equal(last.options?.redirect, 'error');
  assert.equal(new Headers(last.options?.headers).get('Authorization'), 'Bearer memory-only-proof');
  assert.ok(calls.every((call) => !call.url.includes('memory-only-proof')));
  assert.throws(() => serverURL('//other.example/api'), /registered origin/);
  assert.throws(() => serverURL('https://other.example/api'), /registered origin/);
});

void test('registry resolution refuses incompatible, ambiguous and non-public web schemes', async (t) => {
  const id = 'b'.repeat(32);
  let origin = 'http://192.168.1.2';
  let compatible = true;
  t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(
      Response.json({ id, name: 'B', origin, publicKey: 'x'.repeat(43), online: true, compatible }),
    ),
  );
  const page = new URL(`https://portal.example/manage/servers/${id}`);
  await assert.rejects(resolveServer(page), /Invalid registered/);
  origin = 'https://b.example';
  compatible = false;
  await assert.rejects(resolveServer(page), /needs an update/);
  await assert.rejects(resolveServer(new URL(`${page}/invalid`)), /Invalid management/);
  assert.equal(await resolveServer(new URL('https://portal.example/editor.html')), undefined);
});

void test('guest identifiers stay stable per server and different across servers', () => {
  const a = guestIdentity('a'.repeat(32));
  const b = guestIdentity('b'.repeat(32));
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.notEqual(a, b);
  assert.equal(guestIdentity('a'.repeat(32)), a);
});

void test('new room visits use Guest for missing and expired central sessions without storage choices', async (t) => {
  let expired = false;
  const calls: { url: string; options: RequestInit | undefined }[] = [];
  t.mock.method(globalThis, 'fetch', (input: string | URL, options?: RequestInit) => {
    const url = String(input);
    calls.push({ url, options });
    if (url === '/api/v1/account')
      return Promise.resolve(Response.json({ account: '', expired, loginAvailable: true }));
    return Promise.resolve(Response.json({ ok: true }));
  });
  for (const value of [false, true]) {
    expired = value;
    await initializeIdentity();
    await serverAPI('/api/v1/me');
    const headers = new Headers(calls.at(-1)?.options?.headers);
    assert.match(headers.get('X-Guest-ID') ?? '', /^[a-f0-9]{32}$/);
    assert.equal(headers.get('Authorization'), null);
  }
  assert.ok(calls.every(({ url }) => url !== '/identity/v1/access'));
});

void test('proof expiry during an account visit fails closed until a new visit', async (t) => {
  let renewals = 0;
  t.mock.method(globalThis, 'fetch', (input: string | URL) => {
    if (String(input) === '/api/v1/account')
      return Promise.resolve(
        Response.json({ account: 'account', expired: false, loginAvailable: true }),
      );
    if (String(input) === '/identity/v1/access') {
      renewals++;
      return Promise.resolve(
        renewals === 1
          ? Response.json({
              proof: 'short-proof',
              expiresAt: new Date(Date.now() + 1000).toISOString(),
            })
          : Response.json({ error: 'expired' }, { status: 401 }),
      );
    }
    assert.fail('Expired account must not reach the server as Guest');
  });
  await initializeIdentity();
  await assert.rejects(serverAPI('/api/v1/me'), /Authentication expired/);
  await assert.rejects(serverAPI('/api/v1/me'), /Authentication expired/);
  // A session expiring between account lookup and initial proof acquisition is already Guest.
  await initializeIdentity();
  const { authentication } = await import('../../src/network/identity');
  assert.ok('guest' in (await authentication()));
});
