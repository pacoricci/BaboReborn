import { bindingLabel } from '../../player/game-options';
import { RenderClock } from './render-clock';
import { serverContext } from '../../network/context';
import { startWithContent } from '../../bootstrap/content';
import { readIdentity, publicServerAPI, serverAPI } from '../../network/identity';
import { roomsPath, roomReference, matchRoom } from '../../navigation/routes';
import { MatchAccess } from './access';
import type { AccessEvent } from './access';
import { parseServerInfo, prepareConnection } from '../../network/discovery';
import { readAppearance, unavailableAppearance } from '../../presentation/ui/appearance-settings';
import { matchMenuState } from './menu-state';
import { createMatchScreen } from './screen';
import { mountMatchScreen } from './screen-view';
import './style.css';
import { readSettings, saveSettings } from '../../player/player-settings';
import { CombatAudio } from '../../presentation/audio/combat-audio';
import { SceneAudio } from '../../presentation/audio/scene-audio';
import { MatchMusic } from '../../presentation/audio/match-music';
import { CombatFeedback } from './combat-feedback';
import { OnlineInput } from './input';
import { ArenaRenderer, createArenaEngine } from '../../presentation/scene/renderer';
import type { Shot } from '../../core/simulation';
import { TICK_HZ } from '../../core/timing';
import { PROTOCOL } from '../../contracts/session';
import type { ClientMessage } from '../../contracts/session';
import { Connection } from '../../network/connection';
import { OnlineLifecycle } from './lifecycle';
import { OnlineView } from './view';
import { updateHud } from './hud';
import { updateSniperScope } from './sniper-scope';
import { exportDiagnostics } from './diagnostics';
import { JoinRequest } from './join-request';
import type { Restriction } from '../../contracts/server';
import { SAVED_STATUS_MS } from '../../player/preferences';

const WARNING_REFRESH_MS = 250;

void startWithContent(() => {
  if (unavailableAppearance())
    throw new Error(
      'Your saved skin is unavailable. Choose a skin on the Character page before joining.',
    );
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const canvas = el<HTMLCanvasElement>('game');
  const sniperScope = el('sniper-scope');
  const lifetime = new AbortController();
  const settings = readSettings();
  const audio = new CombatAudio();
  const sceneAudio = new SceneAudio(audio);
  const music = new MatchMusic();
  audio.enabled = settings.sound;
  const join = new JoinRequest(
    (action, delay) => {
      const timer = setTimeout(action, delay);
      return () => clearTimeout(timer);
    },
    () => refreshMenu(),
  );
  let preferencesTimer: ReturnType<typeof setTimeout> | undefined;
  const access = new MatchAccess(
    new URL(location.href),
    serverContext(),
    {
      rooms: async () => {
        const id = matchRoom(new URL(location.href));
        const room = await publicServerAPI<{ id: string; info: unknown }>(`/api/v1/rooms/${id}`);
        return [{ id: room.id, name: parseServerInfo(room.info).name }];
      },
      identity: async () => {
        const identity = await readIdentity();
        if (!identity.expired) {
          const restrictions = await serverAPI<Restriction[]>('/api/v1/me/sanctions');
          const active = restrictions.find(
            (r) =>
              r.revokedAt === null &&
              (r.expiresAt === null || Date.parse(r.expiresAt) > Date.now()),
          );
          if (active)
            throw new Error(
              `${active.reason ? `${active.reason} · ` : 'Access blocked · '}${active.expiresAt === null ? 'permanent' : new Date(active.expiresAt).toLocaleString()}`,
            );
        }
        return identity;
      },
      prepare: prepareConnection,
      storage: {
        getItem: (key) => sessionStorage.getItem(key),
        setItem: (key, value) => sessionStorage.setItem(key, value),
        removeItem: (key) => sessionStorage.removeItem(key),
      },
      schedule: (action, delay) => {
        const timer = setTimeout(action, delay);
        return () => clearTimeout(timer);
      },
    },
    accessEvent,
  );
  const screen = createMatchScreen(settings, access.invite?.href ?? '');
  const ui = mountMatchScreen(el('match-screen'), screen, {
    help: toggleHelp,
    diagnostics: () => {
      const timeline = lifecycle.diagnostics.snapshot(performance.now());
      if (!timeline.samples.length) {
        if (!screen.state.open) showMenu();
        openPanel('options');
        screen.update({ diagnosticsNotice: 'Enable diagnostics in Settings' });
        return;
      }
      exportDiagnostics(snapshot(timeline));
    },
    join: joinMatch,
    arena: returnToArena,
    leave: leaveRoom,
    rooms: roomsPath(),
    equipment: () => {
      showMenu();
      openPanel('match');
    },
    retry: () => location.reload(),
    select: (primary, secondary) => {
      settings.primary = primary;
      settings.secondary = secondary;
      void audio.unlock();
      audio.sample('ui-select');
      selectEquipment();
    },
    options: (patch) => {
      controls.release();
      Object.assign(settings, patch);
      lifecycle.diagnostics.setEnabled(settings.collectDiagnostics, performance.now());
      screen.update({ diagnosticsNotice: '' });
      savePreferences();
      applyOptions();
      audio.sample('ui-confirm');
      void audio.unlock();
    },
    copy: (link) =>
      navigator.clipboard?.writeText(link) ?? Promise.reject(new Error('Clipboard unavailable')),
  });
  let warningTimer: ReturnType<typeof setInterval> | undefined;
  const onlineView = new OnlineView();
  const lifecycle = new OnlineLifecycle<ArenaRenderer>({
    now: () => performance.now(),
    frame,
    closed: (code, reason) => access.closed(code, reason),
    administration(notice) {
      if (notice.action === 'permissions_changed') return;
      clearInterval(warningTimer);
      if (notice.action === 'cancelled') {
        screen.update({ warning: 'Room operation cancelled. The current match continues.' });
        return;
      }
      const deadline = notice.deadlineAtMs ?? performance.now();
      const show = () => {
        screen.update({
          warning: `Room ${notice.action === 'close' ? 'closes' : 'restarts'} in ${Math.max(0, Math.ceil((deadline - performance.now()) / 1000))} seconds.`,
        });
      };
      show();
      warningTimer = setInterval(show, WARNING_REFRESH_MS);
    },
    createEngine: () => createArenaEngine(canvas),
    createRenderer: (message, engine) => {
      const player = { ...message.arena.spawns[0]!, angle: Math.PI / 2, visible: false };
      const renderer = new ArenaRenderer(
        canvas,
        el<HTMLCanvasElement>('minimap'),
        message.arena,
        { player, actors: [] },
        undefined,
        engine,
      );
      renderer.setQuality(settings.quality);
      renderer.reducedEffects = settings.reducedEffects;
      return renderer;
    },
    loading(recovery) {
      const session = lifecycle.session;
      if (session) join.interrupt(session.welcome.round, session.prediction.own);
      else join.cancel();
      controls.release();
      controls.active = false;
      feedback.reset();
      sceneAudio.reset();
      if (recovery) return;
      screen.update({
        title: 'Loading arena…',
        notice: 'Loading arena…',
        results: { intermission: false, summary: '', notice: '', rows: [] },
      });
      refreshMenu();
    },
    initialized(message, recovery) {
      controls.pointerKnown = false;
      controls.pickupID = 0;
      if (!recovery) onlineView.reset(message.arena.width, message.arena.height);
      if (message.type === 'welcome') {
        access.welcome();
      }
      // Preferences express current intent and are safe to reapply after a
      // barrier; buffered movement, fire and respawn commands are never retried.
      selectEquipment();
      send({
        type: 'profile',
        nickname: settings.nickname,
        nicknameColors: settings.nicknameColors,
      });
      send({ type: 'appearance', appearance: readAppearance() });
      screen.update({ arena: message.arena.name });
    },
    loaded(message) {
      screen.update({ connection: message.type === 'welcome' ? '' : 'Changing map…' });
      const resyncRound = message.type === 'resync' ? message.round : undefined;
      if (join.resume(resyncRound, lifecycle.session?.prediction.own)) joinMatch();
    },
    snapshot(change) {
      const session = lifecycle.session!;
      const message = session.latest!;
      if (change.phaseChanged) release();
      const joined = join.settle(session.prediction.own, message.match.phase === 'intermission');
      refreshMenu();
      if (
        (joined && message.match.phase === 'playing') ||
        (!screen.state.open && !screen.state.help && !controls.active)
      )
        returnToArena();
      const own = session.prediction.own!;
      if (change.statusChanged) controls.clearActions();
      if (change.lifeChanged) {
        controls.pointerKnown = false;
        input.aim = { x: own.state.x, y: own.state.y + 2 };
      }
      feedback.receive(change, own);
      screen.update({ connection: own.nickname });
    },
    events(change, now) {
      feedback.receiveEvents(
        change,
        lifecycle.session!.prediction.own!,
        now,
        lifecycle.session!.latest!.players,
        lifecycle.session!.latest!.match,
      );
    },
    failed: failConnection,
  });
  lifecycle.diagnostics.setEnabled(settings.collectDiagnostics, performance.now());
  const feedback = new CombatFeedback(audio, () => lifecycle.renderer);
  let last = performance.now();
  const controls = new OnlineInput(
    canvas,
    el('crosshair'),
    {
      help: toggleHelp,
      suspend: showMenu,
      // The shortcut closes the whole menu from any panel, never just steps back.
      play: returnToArena,
      dead: () => lifecycle.session?.prediction.own?.status === 'dead',
      respawn: () => {
        if (menuState()?.canRespawn && lifecycle.ready) send({ type: 'respawn' });
      },
    },
    () => settings.bindings,
  );
  const input = controls.input;
  function send(message: ClientMessage): void {
    lifecycle.send(message);
  }
  function release(): void {
    controls.release();
    lifecycle.session?.release();
    send({ type: 'release' });
  }
  function menuState() {
    const own = lifecycle.session?.prediction.own;
    const latest = lifecycle.session?.latest;
    return own && latest
      ? matchMenuState(
          own,
          latest.match,
          latest.tick,
          lifecycle.session!.welcome.tickHz,
          join.joining,
          bindingLabel(settings.bindings.fire),
        )
      : null;
  }
  function openPanel(name: 'match' | 'options'): void {
    if (screen.state.panel !== name) audio.sample('ui-select');
    screen.update({ panel: name });
  }
  let helpFromArena = false;
  function toggleHelp(): void {
    if (screen.state.help) {
      audio.sample('ui-close');
      screen.update({ help: false });
      if (helpFromArena) returnToArena();
      return;
    }
    if (!screen.state.ready || join.joining) return;
    audio.sample('ui-open');
    helpFromArena = controls.active;
    controls.active = false;
    release();
    canvas.inert = true;
    document.body.classList.remove('playing');
    screen.update({ help: true });
  }
  function showMenu(): void {
    const wasHidden = !screen.state.open;
    if (wasHidden) audio.sample('ui-open');
    sceneAudio.reset();
    controls.active = false;
    release();
    screen.update({ help: false, open: true });
    canvas.inert = true;
    document.body.classList.remove('playing');
  }
  // Returning to a view must never send join or respawn. Only explicit actions do.
  function returnToArena(): void {
    if (
      !lifecycle.renderer ||
      !lifecycle.ready ||
      !lifecycle.connection?.connected ||
      !menuState() ||
      join.joining
    )
      return;
    release();
    void audio.unlock();
    if (screen.state.open) audio.sample('ui-close');
    music.start();
    controls.active = true;
    // The menu always reopens on its main panel.
    screen.update({ open: false, help: false, panel: 'match' });
    canvas.inert = false;
    document.body.classList.add('playing');
    canvas.focus();
  }
  function refreshMenu(): void {
    const session = lifecycle.session;
    screen.refresh({
      own: session?.prediction.own,
      match: session?.latest?.match,
      players: session?.latest?.players,
      tick: session?.latest?.tick ?? 0,
      tickHz: session?.welcome.tickHz ?? TICK_HZ,
      ready: lifecycle.ready || lifecycle.recovering,
      failure: lifecycle.failure,
      hasSession: !!session,
      joining: join.joining,
      joinProblem: join.problem,
    });
  }
  function failConnection(message: string): void {
    audio.stop();
    sceneAudio.reset();
    audio.sample('ui-error');
    music.stop();
    join.cancel();
    showMenu();
    screen.update({
      connection: lifecycle.session ? 'Disconnected' : 'Unable to connect',
      ...(!lifecycle.session ? { arena: 'UNAVAILABLE' } : {}),
      title: lifecycle.session ? 'Connection interrupted' : 'Unable to enter room',
      notice: message,
      serverInfo: '',
    });
    refreshMenu();
  }
  function joinMatch(): void {
    if (!lifecycle.ready || !lifecycle.connection?.connected || !menuState()?.canJoin) return;
    void audio.unlock();
    audio.sample('ui-confirm');
    music.start();
    release();
    join.start();
    send({ type: 'join' });
    refreshMenu();
  }
  function leaveRoom(): void {
    music.stop();
    release();
    join.cancel();
    lifecycle.connection?.close();
    location.assign(roomsPath());
  }
  document.addEventListener(
    'visibilitychange',
    () => {
      if (lifecycle.diagnostics.enabled)
        lifecycle.diagnostics.record('visibility', performance.now(), { hidden: document.hidden });
      if (document.hidden) audio.stop();
      music.sync();
    },
    { signal: lifetime.signal },
  );
  window.addEventListener(
    'pagehide',
    () => {
      access.dispose();
      clearTimeout(preferencesTimer);
      clearInterval(warningTimer);
      audio.stop();
      music.dispose();
      join.cancel();
      lifecycle.dispose();
      controls.dispose();
      lifetime.abort();
      ui.dispose();
      screen.dispose();
    },
    { once: true },
  );
  // A bfcache restore must not revive a disposed socket/engine or stale UI subscriptions.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  canvas.inert = true;
  function savePreferences(): void {
    clearTimeout(preferencesTimer);
    const saved = saveSettings(settings);
    screen.update({
      settings: { ...settings },
      preferencesStatus: saved
        ? 'Saved.'
        : 'Storage unavailable. Preferences may be lost when you leave.',
    });
    if (saved)
      preferencesTimer = setTimeout(
        () => screen.update({ preferencesStatus: '' }),
        SAVED_STATUS_MS,
      );
  }
  function applyOptions(): void {
    audio.enabled = settings.sound;
    audio.volume = settings.volume / 100;
    music.configure(settings.music, settings.musicVolume / 100);
    lifecycle.renderer?.setQuality(settings.quality);
    if (lifecycle.renderer) lifecycle.renderer.reducedEffects = settings.reducedEffects;
    el('crosshair').style.setProperty('--crosshair-size', `${settings.crosshairSize}px`);
    el('crosshair').style.setProperty('--crosshair-color', settings.crosshairColor);
  }
  applyOptions();
  function selectEquipment(): void {
    savePreferences();
    send({ type: 'select', primary: settings.primary, secondary: settings.secondary });
    refreshMenu();
  }
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (lifecycle.session?.prediction.own?.status === 'spectator') {
        e.preventDefault();
        onlineView.zoom(
          e.deltaY,
          Math.max(lifecycle.session.welcome.arena.width, lifecycle.session.welcome.arena.height),
        );
      }
    },
    { passive: false, signal: lifetime.signal },
  );
  canvas.addEventListener(
    'webglcontextlost',
    (e) => {
      e.preventDefault();
      lifecycle.connection?.close();
      lifecycle.fail('Graphics interrupted. Reload to reconnect.');
    },
    { signal: lifetime.signal },
  );
  window.addEventListener('resize', () => lifecycle.renderer?.resize(), {
    signal: lifetime.signal,
  });
  function snapshot(timeline: ReturnType<typeof lifecycle.diagnostics.snapshot>) {
    const prediction = lifecycle.session?.prediction;
    return {
      protocol: PROTOCOL,
      server: access.url.origin,
      connected: lifecycle.connection?.connected ?? false,
      active: controls.active,
      local: prediction?.player,
      own: prediction?.own,
      authority: lifecycle.session?.latest,
      pending: prediction?.pending.length,
      input: structuredClone(input),
      rttMs: lifecycle.connection?.rtt ?? 0,
      payloadBytesIn: lifecycle.connection?.payloadBytesIn ?? 0,
      payloadBytesOut: lifecycle.connection?.payloadBytesOut ?? 0,
      webSocketExtensions: lifecycle.connection?.webSocketExtensions ?? '',
      arena: lifecycle.session?.welcome.arena.id ?? null,
      buildAsset: import.meta.url,
      timeOriginMs: performance.timeOrigin,
      timeline,
      tickHz: TICK_HZ,
      snapshotHz: 30,
      interpolationMs: 100,
      userAgent: navigator.userAgent,
      rendering: lifecycle.renderer
        ? {
            assets: { ...lifecycle.renderer.kit.status },
            appearance: lifecycle.renderer.appearanceSnapshot(),
            width: lifecycle.renderer.engine.getRenderWidth(),
            height: lifecycle.renderer.engine.getRenderHeight(),
            webGLVersion: lifecycle.renderer.engine.webGLVersion,
            camera: {
              x: lifecycle.renderer.camera.position.x,
              y: lifecycle.renderer.camera.position.z,
              height: lifecycle.renderer.camera.position.y,
            },
          }
        : null,
    };
  }
  function consumed(shot: Shot | null): void {
    controls.consume();
    feedback.predicted(shot);
  }
  const renderClock = new RenderClock();
  function frame(): void {
    if (lifecycle.renderer?.kit.contentFailure) {
      lifecycle.fail('Game content could not load. Reload to retry.');
      return;
    }

    const now = performance.now(),
      frameMs = now - last,
      elapsed = Math.min(frameMs / 1000, 0.1);
    last = now;
    if (!lifecycle.renderer || !lifecycle.session?.prediction.player) return;
    if (lifecycle.diagnostics.enabled) {
      const playback = lifecycle.session.interpolation.diagnostics(
        now,
        lifecycle.session.welcome.tickHz,
      );
      lifecycle.diagnostics.record('frame', now, {
        intervalMs: frameMs,
        active: controls.active,
        hidden: document.hidden,
        ready: lifecycle.ready,
        tick: lifecycle.session.latest?.tick ?? 0,
        round: lifecycle.session.welcome.round,
        pending: lifecycle.session.prediction.pending.length,
        interpolationStarved: playback.starved,
        interpolationTick: playback.targetTick,
        interpolationRate: playback.playbackRate,
        snapshotAgeMs: playback.latestAgeMs,
      });
    }
    controls.sample();
    if (
      controls.active &&
      controls.pointerKnown &&
      lifecycle.session.prediction.own?.status === 'alive'
    )
      input.aim = lifecycle.renderer.aim(controls.pointer.x, controls.pointer.y);
    lifecycle.session.advance(
      input,
      elapsed,
      now,
      controls.active,
      consumed,
      lifecycle.predictionObserver(now),
    );
    const inputs = lifecycle.session.batch(now);
    if (inputs) send({ type: 'input', inputs });
    // Input sampling, prediction and sends continue on every browser frame.
    const drawElapsed = renderClock.step(now, settings.fps);
    if (drawElapsed === null) return;
    const view = onlineView.compose(
      lifecycle.session,
      input.aim,
      now,
      drawElapsed,
      controls.active,
      input.x,
      input.y,
    );
    sceneAudio.update(
      view,
      drawElapsed,
      controls.active &&
        lifecycle.ready &&
        lifecycle.session.latest?.match.phase === 'playing' &&
        now - lifecycle.session.receivedAt < 500 &&
        !document.hidden,
    );
    lifecycle.renderer.render(
      view,
      input.aim,
      drawElapsed,
      controls.active && lifecycle.session.prediction.own?.status === 'alive',
    );
    lifecycle.session.rendered(now);
    updateSniperScope(
      sniperScope,
      view,
      controls.active,
      lifecycle.renderer.camera.position.y,
      controls.pointer,
    );
    lifecycle.renderer.minimap(view);
    el('damage-flash').style.opacity = String(
      feedback.damage.opacity(now) * (settings.reducedEffects ? 0.2 : 1),
    );
    screen.scores(controls.showScores);
    controls.pickupID = updateHud(lifecycle.session, now, feedback.hitUntil);
  }
  // Translate access outcomes into page state; admission itself has no DOM dependency.
  function accessEvent(event: AccessEvent): void {
    switch (event.type) {
      case 'checking':
        refreshMenu();
        screen.update({ connection: 'Checking room…' });
        break;
      case 'room':
        screen.update({ room: event.name });
        if (event.initial) document.title = `Babo · ${event.name}`;
        break;
      case 'portal':
        screen.update({ portal: event.url });
        break;
      case 'identity':
        break;
      case 'open':
        lifecycle.connect((events) => new Connection(event.url, events));
        break;
      case 'failed':
        lifecycle.fail(event.message);
        break;
      case 'leave':
        location.assign(roomsPath(event.notice, roomReference(serverContext().id, access.roomID)));
        break;
      case 'reconnecting':
        screen.update({ warning: 'Room restarted. Reconnecting as spectator…' });
        break;
      case 'replace':
        location.replace(event.url.href);
        break;
      case 'clean':
        history.replaceState(null, '', event.url);
        break;
    }
  }
  void access.connect();
});
