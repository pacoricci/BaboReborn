import type { Activity } from '../../contracts/activity';
import { EQUIPMENT_NAMES } from '../../core/equipment';

const ROW_LIFETIME_MS = 10_000;

interface FeedRow {
  event: Activity;
  expiresAtMs: number;
}
// Pure presentation state. Replayed activities never extend an event's lifetime.
export class ActivityFeed {
  private round = 0;
  private lastID = 0;
  private rows: FeedRow[] = [];
  receive(events: Activity[], round: number, now: number, authorityNow: number) {
    if (round !== this.round) {
      this.rows = [];
      this.round = round;
      this.lastID = 0;
    }
    for (const event of events) {
      if (event.round !== round || event.id <= this.lastID) continue;
      this.lastID = event.id;
      const remaining = ROW_LIFETIME_MS - Math.max(0, authorityNow - event.occurredAtMs);
      if (remaining > 0) this.rows.push({ event, expiresAtMs: now + remaining });
    }
    this.rows = this.visible(now).slice(-5);
  }
  visible(now: number): FeedRow[] {
    return this.rows.filter((row) => row.expiresAtMs > now);
  }
}
export function activityParts(event: Activity): (string | Activity['actor'])[] {
  if (event.kind === 'connected') return [event.actor, ' connected'];
  if (event.kind === 'disconnected') return [event.actor, ' disconnected'];
  if (event.kind !== 'kill') {
    const actions = {
      'flag-take': 'took the enemy flag',
      'flag-drop': 'dropped the enemy flag',
      'flag-return': 'returned the team flag',
      'flag-capture': 'captured the enemy flag',
    };
    return [event.actor, ` ${actions[event.kind]}`];
  }
  const weapon =
    event.weapon === 'grenade'
      ? 'Grenade'
      : event.weapon === 'molotov'
        ? 'Molotov'
        : EQUIPMENT_NAMES[event.weapon];
  return event.actor.id === event.victim.id
    ? [event.actor, ` eliminated themselves · ${weapon}`]
    : [event.actor, ` — ${weapon} → `, event.victim];
}

export function activityText(event: Activity): string {
  return activityParts(event)
    .map((part) => (typeof part === 'string' ? part : part.nickname))
    .join('');
}
