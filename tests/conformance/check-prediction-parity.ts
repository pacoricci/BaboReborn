import { execFileSync } from 'node:child_process';
import { predictionSuite } from '../../frontend/tests/support/prediction-scenarios';
import {
  compareParityValue,
  predictionReport,
  replayPrediction,
} from '../../frontend/tests/support/prediction-parity';

const expected = replayPrediction();
const actual: unknown = JSON.parse(
  execFileSync('go', ['run', './backend/cmd/conformance'], {
    input: JSON.stringify(predictionSuite),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const maxAbsoluteDifference = compareParityValue(actual, expected);
console.log(
  JSON.stringify(
    {
      suite: 'duplicated-prediction-core',
      ...predictionReport(expected),
      maxAbsoluteDifference,
      status: 'passed',
      scope:
        'Complete player/equipment state, seed, shot cadence and geometry; no authority-owned entity outcomes or original-executable fidelity claim.',
    },
    null,
    2,
  ),
);
