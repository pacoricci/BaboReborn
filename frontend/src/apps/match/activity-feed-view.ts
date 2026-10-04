import type { Activity, Team } from '../../contracts/activity';
import { paintNickname } from '../../ui/nickname';
import { activityParts } from './activity-feed';

function icon(kind: 'team' | 'flag', team: Exclude<Team, 'none'>): HTMLElement {
  const symbol = document.createElement('span');
  symbol.className = `activity-icon activity-${kind} activity-${team}`;
  symbol.setAttribute('role', 'img');
  symbol.setAttribute('aria-label', `${team === 'blue' ? 'Blue' : 'Red'} ${kind}`);
  return symbol;
}

export function activityRow(event: Activity): HTMLLIElement {
  const row = document.createElement('li');
  for (const part of activityParts(event)) {
    if (typeof part === 'string') row.append(part);
    else {
      const participant = document.createElement('span');
      participant.className = 'activity-participant';
      if (part.team !== 'none') participant.append(icon('team', part.team));
      const name = document.createElement('span');
      paintNickname(name, part.nickname, part.nicknameColors);
      participant.append(name);
      row.append(participant);
    }
  }
  if (event.kind.startsWith('flag-') && event.actor.team !== 'none') {
    // Returns concern the actor's flag; all other flag actions concern the enemy's.
    const team =
      event.kind === 'flag-return'
        ? event.actor.team
        : event.actor.team === 'blue'
          ? 'red'
          : 'blue';
    row.append(' ', icon('flag', team));
  }
  return row;
}
