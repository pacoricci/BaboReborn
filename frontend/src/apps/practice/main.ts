import { startWithContent } from '../../content/runtime';
// Practice application: local pause, reset, scoring and timing are scenario policies.
// Input clearing can be reused; pausing an online match cannot.
import './style.css';
import { appearanceControls } from '../../presentation/ui/appearance-controls';
import { ArenaRenderer } from '../../presentation/scene/renderer';
import { RangeAudio } from './audio';
import { createPractice, stepPractice } from './simulation';
import { createPracticeView, updatePracticeView } from './view';
import { PRACTICE_MAX_FRAME_SECONDS } from './config';
import { TICK_SECONDS } from '../../core/timing';
import { SMG } from '../../gameconfig/tuning';
import type { Input, Player } from '../../core/simulation';

void startWithContent(() => {
  const element = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const canvas = element<HTMLCanvasElement>('game');
  const startButton = element<HTMLButtonElement>('start');
  const menu = element('menu');
  const crosshair = element('crosshair');
  const sound = new RangeAudio();
  let world = createPractice();
  const view = createPracticeView(world);
  const appearance = appearanceControls(element('appearance'), (value) => {
    view.player.appearance = value;
  });
  view.player.appearance = appearance.value;
  let renderer: ArenaRenderer;
  let playing = false;
  let started = false;
  let contextLost = false;
  let previous: Player = { ...world.player };
  let accumulator = 0;
  let lastFrame = performance.now();
  let lastHud = 0;
  let hitUntil = 0;
  let noticeUntil = 0;
  let droppedSeconds = 0;
  let activeFrames = 0;
  let pointer = { x: innerWidth / 2, y: innerHeight / 2 };
  let pointerKnown = false;
  const keys = new Set<string>();
  const input: Input = {
    x: 0,
    y: 0,
    aim: { x: world.player.x, y: world.player.y + 2 },
    fire: false,
  };
  const samples: number[] = [];
  const movementKeys = new Set([
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
  ]);
  let simulationTick = 0;
  let pendingInput: { receivedTick: number; receivedAt: number } | null = null;
  const inputApplications: { receivedTick: number; appliedTick: number; delayMs: number }[] = [];
  function markInput(): void {
    if (playing && !pendingInput)
      pendingInput = { receivedTick: simulationTick, receivedAt: performance.now() };
  }

  function clearInput(): void {
    keys.clear();
    input.x = 0;
    input.y = 0;
    input.fire = false;
    pendingInput = null;
  }

  function pause(): void {
    sound.stop();
    if (!playing) return;
    playing = false;
    clearInput();
    accumulator = 0;
    document.body.classList.remove('playing');
    menu.hidden = false;
    element('menu-label').textContent = 'RANGE PAUSED';
    element('menu-title').innerHTML = 'Take a breath.<br><em>Keep your aim.</em>';
    element('menu-copy').textContent =
      'Your range is right where you left it. Resume when you’re ready.';
    startButton.innerHTML = 'Back to the range <span>↗</span>';
    startButton.focus();
  }

  function play(): void {
    if (!renderer || contextLost) return;
    clearInput();
    playing = true;
    started = true;
    pointerKnown = false;
    input.aim = {
      x: world.player.x + Math.cos(world.player.angle) * 2,
      y: world.player.y + Math.sin(world.player.angle) * 2,
    };
    lastFrame = performance.now();
    accumulator = 0;
    previous = { ...world.player };
    document.body.classList.add('playing');
    menu.hidden = true;
    canvas.focus();
    void sound.unlock().catch(() => {
      sound.enabled = false;
      element('sound').textContent = 'Sound off';
    });
  }

  function reset(): void {
    sound.stop();
    clearInput();
    world = createPractice();
    world.movingTargets = element<HTMLInputElement>('moving').checked;
    previous = { ...world.player };
    accumulator = 0;
    samples.length = 0;
    droppedSeconds = 0;
    activeFrames = 0;
    input.aim = { x: world.player.x, y: world.player.y + 2 };
    pointerKnown = false;
    hitUntil = 0;
    noticeUntil = 0;
    renderer.reset(world.player);
    updateHud(performance.now());
  }

  startButton.addEventListener('click', play);
  element('pause').addEventListener('click', pause);
  element<HTMLInputElement>('moving').addEventListener('change', (event) => {
    world.movingTargets = (event.target as HTMLInputElement).checked;
  });
  element('sound').addEventListener('click', () => {
    sound
      .toggle()
      .then((enabled) => {
        element('sound').textContent = enabled ? 'Sound on' : 'Sound off';
        element('sound').setAttribute('aria-pressed', String(enabled));
      })
      .catch((error: unknown) => console.error('Could not toggle sound', error));
  });
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      if (playing) pause();
      else if (started) play();
      return;
    }
    if (!playing) {
      if (
        event.code === 'Enter' &&
        !startButton.disabled &&
        (event.target === document.body || event.target === canvas)
      )
        play();
      return;
    }
    if (movementKeys.has(event.code)) {
      event.preventDefault();
      keys.add(event.code);
      markInput();
    }
    if (event.code === 'KeyR' && !event.repeat) {
      event.preventDefault();
      reset();
    }
  });
  window.addEventListener('keyup', (event) => {
    keys.delete(event.code);
    if (movementKeys.has(event.code)) markInput();
  });
  window.addEventListener('blur', pause);
  window.addEventListener('pagehide', () => sound.stop());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
  canvas.addEventListener('pointermove', (event) => {
    markInput();
    pointer = { x: event.clientX, y: event.clientY };
    pointerKnown = true;
    crosshair.style.left = `${pointer.x}px`;
    crosshair.style.top = `${pointer.y}px`;
  });
  canvas.addEventListener('pointerdown', (event) => {
    if (!playing || event.button !== 0) return;
    event.preventDefault();
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    pointer = { x: event.clientX, y: event.clientY };
    pointerKnown = true;
    input.fire = true;
    markInput();
  });
  window.addEventListener('pointerup', () => {
    input.fire = false;
    markInput();
  });
  canvas.addEventListener('pointercancel', pause);
  canvas.addEventListener('lostpointercapture', () => {
    input.fire = false;
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    pause();
    element('menu-label').textContent = 'GRAPHICS INTERRUPTED';
    element('menu-copy').textContent =
      'The graphics context was lost. Reload this page to restart the range.';
    startButton.disabled = true;
    startButton.textContent = 'Reload the page to restart';
  });
  window.addEventListener('resize', () => {
    renderer?.resize();
    pointerKnown = false;
  });
  element('metrics-toggle').addEventListener('click', () => {
    const panel = element('metrics');
    panel.hidden = !panel.hidden;
    element('metrics-toggle').setAttribute('aria-expanded', String(!panel.hidden));
    element('metrics-toggle').textContent = panel.hidden ? 'Show performance' : 'Hide performance';
  });

  function stats() {
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
    const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
    return {
      samples: samples.length,
      fps: mean ? 1000 / mean : 0,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    };
  }

  function updateHud(now: number): void {
    element('speed').textContent = Math.hypot(world.player.vx, world.player.vy).toFixed(2);
    element('eliminations').textContent = String(world.eliminations).padStart(2, '0');
    element('accuracy').textContent = world.shots
      ? `${Math.round((world.hits / world.shots) * 100)}%`
      : '—';
    element('time').textContent =
      `${String(Math.floor(world.time / 60)).padStart(2, '0')}:${String(Math.floor(world.time % 60)).padStart(2, '0')}`;
    element('weapon-ready').style.width =
      `${Math.max(0, 1 - world.player.cooldown / (world.player.cooldown > SMG.fireIntervalSeconds ? SMG.equipDelaySeconds : SMG.fireIntervalSeconds)) * 100}%`;
    crosshair.classList.toggle('hit', now < hitUntil);
    if (now >= noticeUntil) element('hit-notice').textContent = '';
    updatePracticeView(view, world, world.player);
    renderer.minimap(view);
    if (!element('metrics').hidden) {
      const report = stats();
      element('metrics-values').textContent =
        `${report.fps.toFixed(0)} FPS · ${report.samples} frames\np95 ${report.p95.toFixed(1)} ms · p99 ${report.p99.toFixed(1)} ms\n${renderer.engine.getRenderWidth()} × ${renderer.engine.getRenderHeight()} actual pixels`;
    }
  }

  function snapshot() {
    return {
      mode: playing ? 'playing' : started ? 'paused' : 'ready',
      world: structuredClone({
        player: world.player,
        targets: world.targets,
        random: world.random,
        time: world.time,
        shots: world.shots,
        hits: world.hits,
        eliminations: world.eliminations,
        movingTargets: world.movingTargets,
      }),
      input: { ...input, aim: { ...input.aim }, keys: [...keys] },
      rendering: {
        assets: { ...renderer.kit.status },
        appearance: renderer.appearanceSnapshot(),
        width: renderer.engine.getRenderWidth(),
        height: renderer.engine.getRenderHeight(),
        webGLVersion: renderer.engine.webGLVersion,
        meshes: renderer.scene.meshes.length,
        camera: {
          x: renderer.camera.position.x,
          y: renderer.camera.position.z,
          height: renderer.camera.position.y,
        },
      },
      frames: stats(),
      activeFrames,
      droppedSeconds,
      simulationTick,
      inputApplications: [...inputApplications],
    };
  }

  element('export').addEventListener('click', () => {
    const report = {
      format: 'baboreborn-local-range-v1',
      recordedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      prototype: '0.1.0',
      build: import.meta.env.DEV ? 'development' : 'production',
      referenceRevision: '20acde0',
      renderer: 'Babylon.js 9.25.0 / WebGL2',
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      conditions: {
        clients: 1,
        server: 'none',
        network: 'offline simulation; loopback asset server',
        map: world.config.arena.name,
        weapons: ['SMG'],
        fixedStepHz: 1 / TICK_SECONDS,
        shotGeometry: world.config.shotGeometry,
        hardware: 'Record separately',
        displayRefreshHz: 'Record separately',
        revision: 'Record git revision and dirty state separately',
      },
      diagnosticOnly: true,
      samplePolicy:
        'Last 3600 active frame intervals; first 2 simulation seconds excluded; pauses excluded.',
      ...snapshot(),
      frameIntervalsMs: samples,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `baboreborn-range-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  function frame(): void {
    const now = performance.now(),
      elapsed = (now - lastFrame) / 1000;
    lastFrame = now;
    if (contextLost) return;
    if (playing) {
      const dt = Math.min(elapsed, PRACTICE_MAX_FRAME_SECONDS);
      droppedSeconds += Math.max(0, elapsed - dt);
      activeFrames++;
      if (world.time > 2 && elapsed > 0) {
        samples.push(elapsed * 1000);
        if (samples.length > 3600) samples.shift();
      }
      input.x =
        Number(keys.has('KeyD') || keys.has('ArrowRight')) -
        Number(keys.has('KeyA') || keys.has('ArrowLeft'));
      input.y =
        Number(keys.has('KeyW') || keys.has('ArrowUp')) -
        Number(keys.has('KeyS') || keys.has('ArrowDown'));
      if (pointerKnown) input.aim = renderer.aim(pointer.x, pointer.y);
      accumulator += dt;
      while (accumulator + 1e-10 >= TICK_SECONDS) {
        previous = { ...world.player };
        const shot = stepPractice(world, input, TICK_SECONDS);
        accumulator -= TICK_SECONDS;
        simulationTick++;
        if (pendingInput) {
          inputApplications.push({
            receivedTick: pendingInput.receivedTick,
            appliedTick: simulationTick,
            delayMs: performance.now() - pendingInput.receivedAt,
          });
          if (inputApplications.length > 128) inputApplications.shift();
          pendingInput = null;
        }
        if (shot) {
          renderer.shot(shot);
          sound.shot(shot.hit);
          if (shot.hit) hitUntil = now + 100;
          if (shot.killed) {
            element('hit-notice').textContent = '+1 TARGET DOWN';
            noticeUntil = now + 1000;
          }
        }
      }
    }
    const alpha = playing ? Math.max(0, accumulator / TICK_SECONDS) : 1;
    const displayed = {
      ...world.player,
      x: previous.x + (world.player.x - previous.x) * alpha,
      y: previous.y + (world.player.y - previous.y) * alpha,
    };
    updatePracticeView(view, world, displayed);
    sound.update(view, elapsed, playing && !document.hidden);
    renderer.render(view, input.aim, Math.min(elapsed, PRACTICE_MAX_FRAME_SECONDS), playing);
    if (now - lastHud > 100) {
      updateHud(now);
      lastHud = now;
    }
  }

  try {
    renderer = new ArenaRenderer(
      canvas,
      element<HTMLCanvasElement>('minimap'),
      world.config.arena,
      view,
    );
    startButton.disabled = false;
    startButton.innerHTML = 'Enter the range <span>↗</span>';
    renderer.engine.runRenderLoop(frame);
    // Read-only diagnostics for browser checks; no test mutation hooks in the game.
    Object.defineProperty(window, '__baboReborn', {
      value: Object.freeze({ snapshot }),
      configurable: false,
    });
  } catch (error) {
    console.error(error);
    element('menu-label').textContent = 'COULD NOT START THE ARENA';
    element('menu-copy').textContent = error instanceof Error ? error.message : String(error);
    startButton.textContent = 'Reload after enabling WebGL 2';
    startButton.disabled = true;
  }
});
