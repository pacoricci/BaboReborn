import { CombatAudio } from '../../frontend/src/presentation/audio/combat-audio';
import { AUDIO_SAMPLES, sampleFiles } from '../../frontend/src/presentation/audio/audio-catalog';
import type { AudioSample } from '../../frontend/src/presentation/audio/audio-catalog';

const labels: Record<AudioSample, string> = {
  spawn: 'Spawn',
  'shield-end': 'Shield end',
  'shield-hit': 'Shield hit',
  'minibot-start': 'Minibot start',
  'minibot-end': 'Minibot end',
  'chain-ready': 'Chain ready',
  'charge-ready': 'Charge ready',
  'fire-loop': 'Fire loop',
  'fire-end': 'Fire end',
  'roll-loop': 'Roll loop',
  'roll-stop': 'Roll stop',
  'player-impact': 'Player impact',
  'item-impact': 'Item impact',
  'rocket-loop': 'Rocket loop',
  'photon-loop': 'Photon loop',
  'photon-end': 'Photon end',
  'scope-in': 'Scope in',
  'scope-out': 'Scope out',
  'ambient-loop': 'Ambient loop',
  'round-start': 'Round start',
  'round-end': 'Round end',
  victory: 'Victory',
  defeat: 'Defeat',
  'pickup-grenade': 'Pickup grenade',
  'rocket-explosion': 'Rocket explosion',
  'photon-impact': 'Photon impact',
  'flame-impact': 'Flame impact',
  'ui-confirm': 'Ui confirm',
  'ui-error': 'Ui error',
  'ui-select': 'Ui select',
  'ui-open': 'Ui open',
  'ui-close': 'Ui close',
  connected: 'Connected',
  disconnected: 'Disconnected',

  smg: 'SMG',
  shotgun: 'Shotgun',
  dual: 'Dual Machine Gun',
  chain: 'Chain Gun',
  sniper: 'Sniper',
  bazooka: 'Bazooka',
  photon: 'Photon Rifle',
  flamethrower: 'Flamethrower',
  minibot: 'Minibot',
  explosion: 'Explosion',
  hit: 'Hit confirmation',
  damage: 'Damage received',
  death: 'Death',
  round: 'Round change',
  reload: 'Reload',
  charge: 'Photon charge',
  overheat: 'Overheat',
  knives: 'Knives',
  shield: 'Shield',
  throw: 'Throw',
  bounce: 'Grenade bounce',
  'molotov-break': 'Molotov break',
  ricochet: 'Surface impact',
  'pickup-health': 'Health pickup',
  'pickup-equipment': 'Equipment pickup',
  'flag-take': 'Flag taken',
  'flag-drop': 'Flag dropped',
  'flag-return': 'Flag returned',
  'flag-capture': 'Flag captured',
};
const sounds = (Object.keys(AUDIO_SAMPLES) as AudioSample[]).flatMap((kind) =>
  sampleFiles(kind).map((file, index, files) => ({
    kind,
    file,
    label: labels[kind] + (files.length > 1 ? ` · ${index + 1}` : ''),
  })),
);
const section = document.querySelector<HTMLElement>('#sounds')!;
const status = document.querySelector<HTMLElement>('#status')!;
const position = document.querySelector<HTMLInputElement>('#position')!;
const mix = new CombatAudio();
const players: HTMLAudioElement[] = [];
let sequence = -1;
let request = 0;

function stop(): void {
  request++;
  sequence = -1;
  mix.stop();
  for (const player of players) {
    player.pause();
    player.currentTime = 0;
  }
}
function play(index: number): void {
  status.textContent = `Playing ${sounds[index]!.label}.`;
  void players[index]!.play().catch(() => {
    status.textContent = 'Playback is unavailable. Try the sample controls again.';
  });
}
for (const [index, { kind, file, label }] of sounds.entries()) {
  const card = document.createElement('article');
  const heading = document.createElement('h2');
  heading.textContent = label;
  const player = document.createElement('audio');
  player.controls = true;
  player.preload = 'metadata';
  player.src = `/audio/${file}`;
  player.setAttribute('aria-label', label);
  player.addEventListener('play', () => {
    mix.stop();
    for (const other of players) if (other !== player) other.pause();
    if (sequence !== index) sequence = -1;
    status.textContent = `Playing ${label}.`;
  });
  player.addEventListener('ended', () => {
    if (sequence === index && index + 1 < players.length) {
      sequence++;
      play(sequence);
    } else {
      sequence = -1;
      status.textContent = 'Playback complete.';
    }
  });
  players.push(player);
  const button = document.createElement('button');
  button.textContent =
    sampleFiles(kind).length > 1 ? 'In-game mix · rotating takes' : 'In-game mix';
  button.setAttribute('aria-label', `Play ${label} in the game mix`);
  button.addEventListener('click', () => {
    stop();
    const current = request;
    void mix.unlock().then(() => {
      if (current !== request || document.hidden) return;
      const personal =
        kind.startsWith('pickup-') ||
        kind.startsWith('flag-') ||
        ['hit', 'damage', 'death', 'round'].includes(kind);
      mix.sample(kind, personal ? undefined : { x: Number(position.value), y: 0 });
      status.textContent = `${label} · in-game mix${personal ? ' · personal / global cue' : ''}.`;
    });
  });
  card.append(heading, player, button);
  section.append(card);
}
position.addEventListener('input', () => {
  const x = Number(position.value);
  document.querySelector<HTMLOutputElement>('#position-value')!.value =
    x === 0 ? 'Center' : `${Math.abs(x)} units ${x < 0 ? 'left' : 'right'}`;
});
document.querySelector('#stop')!.addEventListener('click', () => {
  stop();
  status.textContent = 'Stopped.';
});
document.querySelector('#play-all')!.addEventListener('click', () => {
  stop();
  sequence = 0;
  play(0);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop();
});
window.addEventListener('pagehide', stop);
