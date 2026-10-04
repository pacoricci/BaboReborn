import { CombatAudio } from '../../presentation/audio/combat-audio';
import { SceneAudio } from '../../presentation/audio/scene-audio';
import { readSettings } from '../../player/player-settings';
import type { Catalog } from '../../content/types';
import { ArenaRenderer, createArenaEngine } from '../../presentation/scene/renderer';
import type { ArenaMap } from '../../maps/types';
import type { Input } from '../../core/simulation';
import { TICK_SECONDS } from '../../core/timing';
import type { PlayerView } from '../../presentation/view';
import { createMapTrial } from './play-world';

export function startTrial(
  canvas: HTMLCanvasElement,
  minimap: HTMLCanvasElement,
  arena: ArenaMap,
  spawn: number,
  status: (message: string) => void,
  exit: () => void,
  content?: Catalog,
): () => void {
  const sound = new CombatAudio();
  const settings = readSettings();
  sound.enabled = settings.sound;
  sound.volume = settings.volume / 100;
  const sceneAudio = new SceneAudio(sound);
  void sound.unlock();
  const trial = createMapTrial(arena, spawn);
  const player: PlayerView = { ...trial.player, primary: 'smg' };
  const view = { player, actors: [] };
  const engine = createArenaEngine(canvas);
  let renderer: ArenaRenderer;
  try {
    renderer = new ArenaRenderer(canvas, minimap, arena, view, undefined, engine, content);
  } catch (error) {
    sound.dispose();
    engine.dispose();
    throw error;
  }
  const events = new AbortController();
  const options = { signal: events.signal };
  const keys = new Set<string>();
  const input: Input = { x: 0, y: 0, fire: false, aim: { x: player.x, y: player.y + 2 } };
  let pointer: { x: number; y: number } | null = null;
  let last = performance.now(),
    accumulator = 0,
    lastStatus = 0;
  const clear = () => {
    sound.stop();
    sceneAudio.reset();
    keys.clear();
    input.fire = false;
    pointer = null;
    accumulator = 0;
    last = performance.now();
  };
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.code === 'Escape') {
        event.preventDefault();
        exit();
        return;
      }
      if (/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(event.code)) {
        event.preventDefault();
        keys.add(event.code);
      }
    },
    options,
  );
  window.addEventListener('keyup', (event) => keys.delete(event.code), options);
  window.addEventListener('blur', clear, options);
  document.addEventListener('visibilitychange', clear, options);
  canvas.addEventListener(
    'pointermove',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
    },
    options,
  );
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      void sound.unlock();
      canvas.focus();
      input.fire = true;
      pointer = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    },
    options,
  );
  window.addEventListener(
    'pointerup',
    () => {
      input.fire = false;
    },
    options,
  );
  canvas.addEventListener(
    'lostpointercapture',
    () => {
      input.fire = false;
    },
    options,
  );
  canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);
  canvas.addEventListener(
    'webglcontextlost',
    (event) => {
      event.preventDefault();
      exit();
    },
    options,
  );
  window.addEventListener('resize', () => renderer.resize(), options);
  engine.runRenderLoop(() => {
    const now = performance.now(),
      elapsed = Math.min(0.1, (now - last) / 1000);
    last = now;
    input.x =
      Number(keys.has('KeyD') || keys.has('ArrowRight')) -
      Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    input.y =
      Number(keys.has('KeyW') || keys.has('ArrowUp')) -
      Number(keys.has('KeyS') || keys.has('ArrowDown'));
    if (pointer) input.aim = renderer.aim(pointer.x, pointer.y);
    accumulator += elapsed;
    while (accumulator >= TICK_SECONDS) {
      const shot = trial.step(input);
      if (shot) {
        renderer.shot(shot);
        sound.shot('smg');
        if (shot.surface) sound.sample('ricochet', shot.to);
      }
      accumulator -= TICK_SECONDS;
    }
    Object.assign(player, { x: trial.player.x, y: trial.player.y, angle: trial.player.angle });
    sceneAudio.update(view, elapsed, !document.hidden);
    renderer.render(view, input.aim, elapsed, true);
    if (now - lastStatus > 150) {
      status(`Spawn ${spawn + 1} · Position ${player.x.toFixed(1)}, ${player.y.toFixed(1)}`);
      renderer.minimap(view);
      lastStatus = now;
    }
  });
  canvas.focus();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    sound.dispose();
    sceneAudio.reset();
    events.abort();
    engine.stopRenderLoop();
    renderer.scene.dispose();
    engine.dispose();
  };
}
