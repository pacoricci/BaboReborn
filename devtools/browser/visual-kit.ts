import { startWithContent } from '../../frontend/src/content/runtime';
import './workshop/style.css';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { CATALOG, entry } from './workshop/catalog';
import { PreviewStage, defaults } from './workshop/stage';
import type { PreviewSettings } from './workshop/stage';
import { appearanceControls } from '../../frontend/src/presentation/ui/appearance-controls';

void startWithContent(() => {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const input = (id: string) => el<HTMLInputElement>(id);
  const select = (id: string) => el<HTMLSelectElement>(id);
  let settings = defaults();
  let reference = structuredClone(settings);
  let playing = false,
    comparing = false,
    stageB: PreviewStage | undefined;
  let imageURL = '',
    lastStatus = '',
    frame = 0,
    alive = true;
  const stage = new PreviewStage(el<HTMLCanvasElement>('preview'));
  const buttons = new Map<string, HTMLButtonElement>();
  const images = new Map<string, HTMLImageElement>();
  const params = new URLSearchParams(location.search);
  if (params.has('asset')) settings.id = entry(params.get('asset')!).id;
  for (const category of new Set(CATALOG.map((a) => a.category)))
    select('category').add(new Option(category, category));
  for (const asset of CATALOG) {
    const button = document.createElement('button');
    button.className = 'asset';
    button.dataset.asset = asset.id;
    const image = document.createElement('img');
    image.alt = '';
    image.hidden = true;
    const text = document.createElement('span');
    text.textContent = asset.name;
    const category = document.createElement('small');
    category.textContent = asset.category;
    text.append(category);
    button.append(image, text);
    button.onclick = () => choose(asset.id);
    el('catalog').append(button);
    buttons.set(asset.id, button);
    images.set(asset.id, image);
    select('reference-asset').add(new Option(asset.name, asset.id));
  }
  function filter() {
    const search = input('search').value.toLowerCase().trim(),
      category = select('category').value;
    let count = 0;
    for (const asset of CATALOG) {
      const show =
        (category === 'all' || asset.category === category) &&
        `${asset.name} ${asset.category}`.toLowerCase().includes(search);
      buttons.get(asset.id)!.hidden = !show;
      if (show) count++;
    }
    el('count').textContent = `${count} / ${CATALOG.length} assets`;
    el('empty').hidden = count !== 0;
  }
  input('search').oninput = filter;
  select('category').onchange = filter;
  const appearance = appearanceControls(el('appearance'), (value) => {
    settings.appearance = value;
  });
  settings.appearance = appearance.value;
  function syncPlay() {
    el('play').textContent = playing ? 'Pause' : 'Play';
    el('play').setAttribute('aria-pressed', String(playing));
  }
  function choose(id: string) {
    settings.id = id;
    settings.time = 0;
    settings.animated = false;
    settings.zoom = 1;
    playing = false;
    syncPlay();
    input('zoom').value = '1';
    const asset = entry(id);
    el('asset-name').textContent = asset.name;
    el('asset-category').textContent = asset.category;
    el('asset-type').textContent = asset.type;
    el('description').textContent = asset.description;
    el('source').replaceChildren();
    if (asset.type === 'GLB model') {
      const link = document.createElement('a');
      link.href = `/assets/kit/models/${id}.glb`;
      link.textContent = `${id}.glb`;
      link.download = `${id}.glb`;
      el('source').append('Model source: ', link);
    } else el('source').textContent = 'Source: shared game presentation adapter';
    el('action-name').textContent = asset.action === 'Inspect' ? 'Turntable preview' : asset.action;
    el('action-help').textContent =
      `${asset.action}. Play or scrub to inspect; Static pose restores the inspection pose. Synthetic 3-second cycle.`;
    el('skin').hidden = ![
      'babo',
      'team-blue',
      'team-red',
      'knives',
      'shield',
      'flash',
      ...CATALOG.filter((a) => a.category === 'Primary weapons').map((a) => a.id),
    ].includes(id);
    for (const [key, button] of buttons) button.setAttribute('aria-pressed', String(key === id));
    history.replaceState(null, '', `${location.pathname}?asset=${encodeURIComponent(id)}`);
    lastStatus = '';
  }
  select('mode').onchange = () => {
    settings.mode = select('mode').value as PreviewSettings['mode'];
    for (const id of ['front', 'top', 'turn'])
      el<HTMLButtonElement>(id).disabled = settings.mode === 'game';
    document.querySelector('.canvas-help')!.textContent =
      settings.mode === 'game'
        ? 'Game camera · scroll to zoom · Frame all restores the default height'
        : 'Drag to orbit · scroll to zoom · Home to fit';
    settings.zoom = 1;
    input('zoom').value = '1';
  };
  input('zoom').oninput = () => {
    settings.zoom = Number(input('zoom').value);
  };
  input('turn').onchange = () => {
    settings.turn = input('turn').checked;
    if (settings.turn) {
      playing = true;
      syncPlay();
    }
  };
  el('fit').onclick = () => {
    settings.zoom = 1;
    input('zoom').value = '1';
  };
  el('front').onclick = () => {
    settings.yaw = 0;
    settings.elevation = 10;
  };
  el('top').onclick = () => {
    settings.yaw = 0;
    settings.elevation = 89;
  };
  el('play').onclick = () => {
    if (entry(settings.id).action === 'Inspect') {
      settings.turn = true;
      input('turn').checked = true;
    }
    if (settings.time >= 3) settings.time = 0;
    settings.animated = true;
    playing = !playing;
    syncPlay();
  };
  el('restart').onclick = () => {
    settings.time = 0;
    settings.animated = true;
  };
  el('step').onclick = () => {
    playing = false;
    settings.animated = true;
    settings.time = Math.min(3, settings.time + 1 / 60);
    syncPlay();
  };
  input('timeline').oninput = () => {
    playing = false;
    settings.animated = true;
    settings.time = Number(input('timeline').value);
    syncPlay();
  };
  el('pose').onclick = () => {
    playing = false;
    settings.animated = false;
    settings.time = 0;
    syncPlay();
  };
  el('reset').onclick = () => {
    const id = settings.id,
      skin = settings.appearance;
    settings = defaults();
    settings.appearance = skin;
    choose(id);
    select('mode').value = 'model';
    for (const id of ['front', 'top', 'turn']) el<HTMLButtonElement>(id).disabled = false;
    input('turn').checked = false;
    select('speed').value = '1';
    input('loop').checked = true;
    select('background').value = 'dark';
  };
  el('retry').onclick = () => location.reload();
  function ensureReference() {
    if (!stageB) stageB = new PreviewStage(el<HTMLCanvasElement>('preview-b'));
  }
  el('compare').onclick = () => {
    comparing = !comparing;
    el('reference').hidden = !comparing;
    el('stages').classList.toggle('comparing', comparing);
    el('compare').setAttribute('aria-pressed', String(comparing));
    if (comparing) {
      ensureReference();
      reference = structuredClone(settings);
      select('reference-asset').value = reference.id;
    }
    stage.resize();
    stageB?.resize();
  };
  select('reference-asset').onchange = () => {
    reference.id = select('reference-asset').value;
    clearImage();
  };
  el('pin').onclick = () => {
    reference = structuredClone(settings);
    select('reference-asset').value = reference.id;
    clearImage();
  };
  function clearImage() {
    if (imageURL) URL.revokeObjectURL(imageURL);
    imageURL = '';
    el('reference-image').hidden = true;
    el('preview-b').hidden = false;
    el('clear-image').hidden = true;
    input('import').value = '';
    stageB?.resize();
  }
  el('clear-image').onclick = clearImage;
  input('import').onchange = () => {
    const file = input('import').files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      el('notice').textContent = 'Choose a PNG, JPEG or WebP image.';
      return;
    }
    if (imageURL) URL.revokeObjectURL(imageURL);
    imageURL = URL.createObjectURL(file);
    const image = el<HTMLImageElement>('reference-image');
    image.src = imageURL;
    image.onload = () => {
      image.hidden = false;
      el('preview-b').hidden = true;
      el('clear-image').hidden = false;
      el('notice').textContent = 'Reference loaded locally. Nothing was uploaded.';
    };
    image.onerror = () => {
      clearImage();
      el('notice').textContent = 'This image could not be decoded.';
    };
  };
  const canvas = el<HTMLCanvasElement>('preview');
  let pointer: { x: number; y: number } | undefined;
  canvas.onpointerdown = (event) => {
    pointer = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointerup = canvas.onpointercancel = () => {
    pointer = undefined;
  };
  canvas.onpointermove = (event) => {
    if (!pointer || settings.mode !== 'model') return;
    settings.yaw += (event.clientX - pointer.x) * 0.6;
    settings.elevation = Math.max(
      -75,
      Math.min(89, settings.elevation + (event.clientY - pointer.y) * 0.5),
    );
    pointer = { x: event.clientX, y: event.clientY };
  };
  function zoom(delta: number) {
    settings.zoom = Math.max(0.4, Math.min(3, settings.zoom + delta));
    input('zoom').value = String(settings.zoom);
  }
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 0.1 : -0.1);
    },
    { passive: false },
  );
  canvas.onkeydown = (event) => {
    if (
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(
        event.key,
      )
    )
      return;
    event.preventDefault();
    if (event.key === 'ArrowLeft') settings.yaw -= 10;
    if (event.key === 'ArrowRight') settings.yaw += 10;
    if (event.key === 'ArrowUp') settings.elevation = Math.min(89, settings.elevation + 10);
    if (event.key === 'ArrowDown') settings.elevation = Math.max(-75, settings.elevation - 10);
    if (event.key === '+' || event.key === '=') zoom(0.1);
    if (event.key === '-') zoom(-0.1);
    if (event.key === 'Home') {
      settings.zoom = 1;
      input('zoom').value = '1';
    }
  };
  function draw() {
    stage.render(settings);
    const background = select('background').value === 'light' ? '#c9cdd3ff' : '#20252dff';
    if (settings.mode === 'model') {
      stage.renderer.scene.clearColor = Color4.FromHexString(background);
      stage.renderer.scene.render();
    }
    if (comparing && !imageURL && stageB) {
      stageB.render({ ...settings, id: reference.id, appearance: reference.appearance });
      if (settings.mode === 'model') {
        stageB.renderer.scene.clearColor = Color4.FromHexString(background);
        stageB.renderer.scene.render();
      }
    }
  }
  el('export').onclick = () => {
    try {
      draw();
      const source = canvas,
        second = imageURL
          ? el<HTMLImageElement>('reference-image')
          : el<HTMLCanvasElement>('preview-b');
      const out = document.createElement('canvas');
      out.width = source.width * (comparing ? 2 : 1);
      out.height = source.height + 80;
      const ctx = out.getContext('2d')!;
      ctx.fillStyle = '#15181d';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.fillStyle = '#eee9df';
      ctx.font = '18px system-ui';
      ctx.fillText(
        `${entry(settings.id).name} · ${settings.mode} · ${settings.time.toFixed(2)}s`,
        16,
        28,
      );
      ctx.drawImage(source, 0, 60);
      if (comparing) {
        ctx.fillText(
          imageURL ? 'Imported reference' : entry(reference.id).name,
          source.width + 16,
          28,
        );
        const sw = second instanceof HTMLImageElement ? second.naturalWidth : second.width;
        const sh = second instanceof HTMLImageElement ? second.naturalHeight : second.height;
        const ratio = Math.min(source.width / sw, source.height / sh);
        ctx.drawImage(
          second,
          source.width + (source.width - sw * ratio) / 2,
          60 + (source.height - sh * ratio) / 2,
          sw * ratio,
          sh * ratio,
        );
      }
      out.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `baboreborn-${settings.id}-${settings.mode}${comparing ? '-comparison' : ''}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        el('notice').textContent = 'PNG exported with the current view and preview time.';
      });
    } catch {
      el('notice').textContent = 'Export failed. Wait for assets to load and try again.';
    }
  };
  function status() {
    const states = stage.status,
      signature = JSON.stringify(states) + settings.id;
    if (signature === lastStatus) return;
    lastStatus = signature;
    const asset = entry(settings.id),
      state = states[`${settings.id}.glb`];
    el('asset-status').textContent =
      asset.type === 'GLB model'
        ? state === 'failed'
          ? 'Failed · temporary substitute visible'
          : state === 'ready'
            ? 'Model loaded'
            : 'Loading · temporary substitute'
        : 'Procedural · no model download required';
    const values = Object.values(states);
    el('loading-summary').textContent =
      `${values.filter((v) => v === 'ready').length}/${values.length} ready`;
    el('loading').replaceChildren(
      ...Object.entries(states).map(([name, value]) => {
        const li = document.createElement('li');
        li.textContent = `${name}: ${value}`;
        return li;
      }),
    );
  }
  async function thumbnails() {
    const thumb = document.createElement('canvas');
    thumb.style.cssText = 'position:fixed;left:-1000px;width:160px;height:120px';
    document.body.append(thumb);
    const preview = new PreviewStage(thumb);
    try {
      await preview.ready();
      for (const asset of CATALOG) {
        if (!alive) break;
        const state = { ...defaults(), id: asset.id };
        preview.render(state);
        await preview.renderer.scene.whenReadyAsync();
        preview.render(state);
        const image = images.get(asset.id)!;
        image.src = preview.image();
        image.hidden = false;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    } finally {
      preview.dispose();
      thumb.remove();
    }
  }
  choose(settings.id);
  if (params.has('category') && CATALOG.some((a) => a.category === params.get('category')))
    select('category').value = params.get('category')!;
  filter();
  let previous = performance.now();
  function tick(now: number) {
    const dt = Math.min((now - previous) / 1000, 0.1);
    previous = now;
    if (playing) {
      settings.time += dt * Number(select('speed').value);
      if (settings.time >= 3) {
        if (input('loop').checked) settings.time %= 3;
        else {
          settings.time = 3;
          playing = false;
          syncPlay();
        }
      }
    }
    draw();
    input('timeline').value = String(settings.time);
    el('time').textContent = `${settings.time.toFixed(2)} / 3.00 s`;
    el('caption-a').textContent =
      `A · ${entry(settings.id).name} · ${settings.mode === 'model' ? 'isolated' : 'game camera'}`;
    status();
    frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);
  void thumbnails();
  window.addEventListener('pagehide', () => {
    alive = false;
    cancelAnimationFrame(frame);
    stage.dispose();
    stageB?.dispose();
    if (imageURL) URL.revokeObjectURL(imageURL);
  });
});
