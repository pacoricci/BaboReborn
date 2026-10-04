// Original Weapon::update: 100 ms deployment, hold, then 250 ms retraction.
// The input is the existing authoritative/predicted cooldown, not a new timer.
export function knifeExtension(remaining: number, cooldown: number): number {
  if (remaining <= 0 || remaining >= cooldown) return 0;
  return Math.max(0, Math.min(1, (cooldown - remaining) / 0.1, remaining / 0.25));
}
