import type { Appearance } from '../../player/appearance';
import type { ProfileStage } from './profile-stage';

export interface ProfileSelection {
  appearance: Appearance;
  primary: string;
}

// Load the arena assets only when the profile preview actually enters the viewport.
export function skinPreview(
  canvas: HTMLCanvasElement,
  changed: (state: { paused: boolean; ready: boolean; message: string }) => void,
) {
  let selection: ProfileSelection;
  let stage: ProfileStage | undefined;
  let loading = false;
  let ready = false;
  let message = '';
  const notify = () => {
    if (!disposed) changed({ paused, ready, message });
  };
  let disposed = false;
  let visible = false;
  let suspended = false;
  let frame = 0;
  let last = 0;
  let drag: { pointer: number; x: number; y: number } | undefined;
  const controls = new AbortController();
  const releaseDrag = () => {
    const pointer = drag?.pointer;
    drag = undefined;
    canvas.classList.remove('dragging');
    if (pointer !== undefined && canvas.hasPointerCapture(pointer))
      canvas.releasePointerCapture(pointer);
  };
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (!stage || !ready || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('dragging');
    },
    { signal: controls.signal },
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      if (!(event.buttons & 1)) {
        releaseDrag();
        return;
      }
      // CSS dimensions keep drag sensitivity independent of canvas resolution.
      stage?.orbit(
        ((event.clientX - drag.x) / Math.max(1, canvas.clientWidth)) * Math.PI * 2,
        ((event.clientY - drag.y) / Math.max(1, canvas.clientHeight)) * Math.PI,
      );
      drag.x = event.clientX;
      drag.y = event.clientY;
    },
    { signal: controls.signal },
  );
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
    canvas.addEventListener(type, releaseDrag, { signal: controls.signal });
  window.addEventListener('blur', releaseDrag, { signal: controls.signal });
  canvas.addEventListener('dblclick', () => stage?.resetView(), { signal: controls.signal });
  canvas.addEventListener(
    'keydown',
    (event) => {
      if (!stage || !ready || event.altKey || event.ctrlKey || event.metaKey) return;
      const step = Math.PI / 12;
      switch (event.key) {
        case 'ArrowLeft':
          stage.orbit(-step, 0);
          break;
        case 'ArrowRight':
          stage.orbit(step, 0);
          break;
        case 'ArrowUp':
          stage.orbit(0, -step);
          break;
        case 'ArrowDown':
          stage.orbit(0, step);
          break;
        case 'Home':
          stage.resetView();
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    { signal: controls.signal },
  );
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = reducedMotion.matches;
  const stop = () => {
    releaseDrag();
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  };
  const render = (now: number) => {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    stage!.render(selection, dt, paused);
    frame = requestAnimationFrame(render);
  };
  const sync = () => {
    if (disposed || suspended || !visible || document.hidden) {
      stop();
      return;
    }
    if (stage) {
      stage.resize();
      if (!frame) frame = requestAnimationFrame(render);
    } else if (!loading && selection) {
      loading = true;
      canvas.style.opacity = '0';
      message = 'Loading your Babo…';
      notify();
      void import('./profile-stage')
        .then(async ({ ProfileStage }) => {
          if (disposed) return;
          const pendingStage = new ProfileStage(canvas, selection);
          stage = pendingStage;
          sync();
          const complete = await pendingStage.ready();
          if (disposed) return;
          canvas.style.opacity = '1';
          ready = true;
          message = complete
            ? ''
            : 'Some preview assets are unavailable; showing simplified models.';
          notify();
        })
        .catch(() => {
          if (disposed) return;
          message = '3D preview unavailable. You can still choose appearance and equipment.';
          notify();
        });
    }
  };
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    sync();
  });
  intersection.observe(canvas);
  const resize = new ResizeObserver(() => stage?.resize());
  resize.observe(canvas);
  const motionChanged = () => {
    paused = reducedMotion.matches;
    notify();
  };
  reducedMotion.addEventListener('change', motionChanged);
  document.addEventListener('visibilitychange', sync);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    controls.abort();
    intersection.disconnect();
    resize.disconnect();
    reducedMotion.removeEventListener('change', motionChanged);
    document.removeEventListener('visibilitychange', sync);
    stage?.dispose();
  };
  window.addEventListener(
    'pagehide',
    (event) => {
      suspended = true;
      stop();
      if (!event.persisted) dispose();
    },
    { signal: controls.signal },
  );
  window.addEventListener(
    'pageshow',
    () => {
      suspended = false;
      sync();
    },
    { signal: controls.signal },
  );
  notify();
  const update = (value: ProfileSelection, description: string): void => {
    if (disposed) return;
    selection = value;
    canvas.setAttribute('aria-label', description);
    sync();
  };
  return {
    update,
    dispose,
    toggle: () => {
      if (disposed || !ready) return;
      paused = !paused;
      notify();
    },
  };
}
