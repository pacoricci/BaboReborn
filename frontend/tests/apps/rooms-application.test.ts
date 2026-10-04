import { queryScope, flushQueries } from '../support/queries';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createManagement,
  ManagementUnavailableError,
  managesRooms,
  moderates,
} from '../../src/apps/management/application';
import type { ManagementData } from '../../src/apps/management/application';
const data: ManagementData = {
  identity: {
    subject: 'account:owner',
    role: 'owner',
    expired: false,
    central: '',
    loginAvailable: true,
  },
  directory: { schema: 1, rooms: [], maps: [], maxRooms: 8 },
};
void test('administrative context ignores older reads and disposal', async () => {
  let resolve!: (value: ManagementData) => void;
  const pending = new Promise<ManagementData>((r) => {
    resolve = r;
  });
  let count = 0;
  const scope = queryScope((client) =>
    createManagement(
      {
        load: () => (++count === 1 ? pending : Promise.resolve(data)),
      },
      client,
    ),
  );
  const context = scope.value;
  const first = pending;
  await context.refresh();
  await flushQueries();
  resolve({ ...data, identity: { ...data.identity, role: 'player' } });
  await first;
  assert.equal(context.state.data?.identity.role, 'owner');
  scope.dispose();
  await context.refresh();
  await flushQueries();
  assert.equal(count, 2);
});
void test('expired identities never carry management authority and failures clear data', async () => {
  assert.equal(managesRooms({ ...data.identity, expired: true }), false);
  assert.equal(moderates({ ...data.identity, role: 'moderator' }), true);
  assert.equal(managesRooms({ ...data.identity, role: 'moderator' }), false);
  let fail = false;
  const scope = queryScope((client) =>
    createManagement(
      {
        load: () => (fail ? Promise.reject(new Error('Revoked')) : Promise.resolve(data)),
      },
      client,
    ),
  );
  const context = scope.value;
  await context.refresh();
  await flushQueries();
  fail = true;
  await context.refresh();
  await flushQueries();
  assert.equal(context.state.data, null);
  assert.equal(context.state.error, 'Revoked');
});

void test('temporary read failures retain drafts and data until authority is explicitly lost', async () => {
  let error: Error | null = null;
  const scope = queryScope((client) =>
    createManagement(
      {
        load: () => (error ? Promise.reject(error) : Promise.resolve(data)),
      },
      client,
    ),
  );
  const context = scope.value;
  await context.refresh();
  await flushQueries();
  error = new ManagementUnavailableError('Network unavailable');
  await context.refresh();
  await flushQueries();
  assert.deepEqual(context.state.data, data);
  assert.equal(context.state.error, 'Network unavailable');
  error = null;
  await context.refresh();
  await flushQueries();
  assert.equal(context.state.error, '');
  error = new Error('Staff access is required.');
  await context.refresh();
  await flushQueries();
  assert.equal(context.state.data, null);
  scope.dispose();
});
