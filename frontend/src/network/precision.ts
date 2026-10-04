// Protocol 1 remote-pose units. Local checkpoints and other scalars are binary64.
export const POSITION_UNITS_PER_WORLD_UNIT = 4096;
export const ANGLE_STEPS_PER_TURN = 65536;

export function decodePosition(value: number): number {
  return value / POSITION_UNITS_PER_WORLD_UNIT;
}

export function decodeAngle(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= ANGLE_STEPS_PER_TURN)
    throw new Error('Invalid quantized angle.');
  // Keep the gameplay convention [-pi, pi); interpolation uses circular distance.
  const signed = value >= ANGLE_STEPS_PER_TURN / 2 ? value - ANGLE_STEPS_PER_TURN : value;
  return signed * ((2 * Math.PI) / ANGLE_STEPS_PER_TURN);
}
