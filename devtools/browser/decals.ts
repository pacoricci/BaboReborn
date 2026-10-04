import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
import { startWithContent, currentContent, loadMap } from '../../frontend/src/content/runtime';
import { ArenaRenderer } from '../../frontend/src/presentation/scene/renderer';
import type { ArenaView } from '../../frontend/src/presentation/view';
import { DEFAULT_APPEARANCE, TARGET_APPEARANCE } from '../../frontend/src/player/appearance';
import { CAMERA } from '../../frontend/src/presentation/camera';

const params = new URLSearchParams(location.search);

void startWithContent(
  async () => {
    const canvas = document.getElementById('preview') as HTMLCanvasElement;
    const enabled = document.getElementById('enabled') as HTMLInputElement;
    const strength = document.getElementById('strength') as HTMLInputElement;
    const quality = document.getElementById('quality') as HTMLSelectElement;
    const status = document.getElementById('status')!;
    const metrics = document.getElementById('metrics')!;
    const select = document.getElementById('arena') as HTMLSelectElement;
    const catalog = currentContent();
    const info = catalog.maps.find((map) => map.id === (params.get('map') ?? 'ion-foundry'));
    if (!info) throw new Error('Map is unavailable');
    for (const map of catalog.maps) select.add(new Option(map.name, map.id));
    select.value = info.id;
    select.onchange = () => {
      const url = new URL(location.href);
      url.searchParams.set('map', select.value);
      url.searchParams.delete('x');
      url.searchParams.delete('y');
      location.href = url.href;
    };
    const arena = await loadMap(info);
    const coordinate = (key: string, size: number) => {
      const value = Number(params.get(key) ?? size / 2);
      return Number.isFinite(value) ? Math.max(0, Math.min(size, value)) : size / 2;
    };
    const target = { x: coordinate('x', arena.width), y: coordinate('y', arena.height) };
    const spawns = [...arena.spawns].sort(
      (a, b) =>
        Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y),
    );
    const [player, reference] = spawns;
    if (!player) throw new Error('Map has no reference spawn');
    const view: ArenaView = {
      camera: { target, height: CAMERA.height },
      player: {
        ...player,
        angle: 0.4,
        appearance: DEFAULT_APPEARANCE,
        primary: 'smg',
      },
      actors: reference
        ? [
            {
              id: 1,
              ...reference,
              angle: 2.2,
              appearance: TARGET_APPEARANCE,
              primary: 'shotgun',
              visible: true,
              healthFraction: 1,
              hitFlash: false,
            },
          ]
        : [],
    };
    const renderer = new ArenaRenderer(canvas, document.createElement('canvas'), arena, view);
    const instrumentation = new SceneInstrumentation(renderer.scene);
    const resize = new ResizeObserver(() => renderer.resize());
    resize.observe(canvas);
    const decals = renderer.decals?.meshes ?? [];
    const update = () => {
      for (const [index, mesh] of decals.entries()) {
        mesh.setEnabled(enabled.checked);
        mesh.visibility = (arena.decals![index]!.opacity * Number(strength.value)) / 75;
      }
    };
    enabled.onchange = strength.oninput = update;
    quality.onchange = () => {
      const value = quality.value;
      if (value === 'low' || value === 'medium' || value === 'high') renderer.setQuality(value);
    };
    for (const [id, y] of [
      ['north', arena.height * 0.375],
      ['center', arena.height / 2],
      ['south', arena.height * 0.625],
    ] as const)
      document.getElementById(id)!.onclick = () => {
        target.y = y;
      };
    document.getElementById('blood')!.onclick = () => renderer.blood(reference ?? player, 30);
    document.getElementById('clear')!.onclick = () => renderer.clearBlood();
    update();
    let previous = performance.now();
    let lastMetrics = 0;
    renderer.engine.runRenderLoop(() => {
      const now = performance.now();
      renderer.render(view, view.player, Math.min((now - previous) / 1000, 0.05), false);
      previous = now;
      if (now - lastMetrics > 500) {
        metrics.textContent = `${enabled.checked ? decals.length : 0} decals · ${instrumentation.drawCallsCounter.current} draw calls · ${renderer.engine.getRenderWidth()} × ${renderer.engine.getRenderHeight()}`;
        lastMetrics = now;
      }
    });
    const dispose = () => {
      resize.disconnect();
      renderer.engine.stopRenderLoop();
      instrumentation.dispose();
      renderer.scene.dispose();
      renderer.engine.dispose();
    };
    window.addEventListener('pagehide', dispose, { once: true });
    try {
      await renderer.scene.whenReadyAsync();
      status.textContent = `Ready · ${arena.name} · ${decals.length} decals`;
    } catch (error) {
      dispose();
      throw error;
    }
  },
  params.get('central') ?? location.origin,
);
