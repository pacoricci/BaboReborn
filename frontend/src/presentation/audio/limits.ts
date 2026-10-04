// Presentation budgets and timing; none of these values affect simulation.
export const AUDIO = {
  ordinaryVoices: 28,
  combatVoices: 32,
  detailVoices: 12,
  loops: 8,
  loopLeaseSeconds: 0.35,
  loopFadeSeconds: 0.03,
  contactGapSeconds: 0.12,
  movementMinSpeed: 0.6, // [cells/s]
  movementFullSpeed: 8, // [cells/s]
  movementTeleportSpeed: 30, // [cells/s]
} as const;
