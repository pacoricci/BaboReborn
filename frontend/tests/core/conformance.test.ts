import test from 'node:test';
import assert from 'node:assert/strict';
import { suite, validateSuite, compareCase } from '../support/conformance';

void test('reference fixture contract and source-backed parameters are valid', validateSuite);

for (const scenario of suite.cases) {
  void test(`source conformance: ${scenario.id}`, () => {
    const result = compareCase(scenario);
    assert.deepEqual(result.differences, [], JSON.stringify(result.differences));
  });
}

void test('comparison detects altered reference values without regenerating expectations', () => {
  const scenario = structuredClone(suite.cases[0]!);
  scenario.checkpoints[0]!.state.x += 0.01;
  const result = compareCase(scenario);
  assert.equal(result.differences.length, 1);
  assert.equal(result.differences[0]!.field, 'x');
  assert.equal(result.differences[0]!.expected, scenario.checkpoints[0]!.state.x);
});
