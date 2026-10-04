import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMINISTRATION_ACTIONS, CLOSE, CLOSE_REASON } from '../../src/contracts/session';

// The Go transport test pins the same fixture to its closure and notice constants.
const contract = JSON.parse(
  readFileSync(
    new URL('../../../backend/server/transport/testdata/session-contract.json', import.meta.url),
    'utf8',
  ),
) as { closeCodes: Record<string, number>; closeReasons: string[]; noticeActions: string[] };

void test('close codes, explained reasons and notice actions match the Go authority', () => {
  assert.deepEqual(CLOSE, contract.closeCodes);
  for (const reason of Object.values(CLOSE_REASON))
    assert.ok(contract.closeReasons.includes(reason), `The server never sends ${reason}`);
  assert.deepEqual([...ADMINISTRATION_ACTIONS], contract.noticeActions);
});
