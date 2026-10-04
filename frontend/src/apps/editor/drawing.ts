import type { EditorApplication } from './application';
import { themeByID } from '../../content/types';
import { contentURL } from '../../content/runtime';
import { decalAt } from './decals';
import { mirrorCells } from './model';
import type { Tool } from './model';
import type { Vec2 } from '../../core/geometry';

/** Canvas dimensions, drawing and pointer capture belong exclusively to this adapter. */
export function attachDrawing(
  canvas: HTMLCanvasElement,
  viewport: HTMLElement,
  app: EditorApplication,
) {
  const surface = canvas.getContext('2d');
  if (!surface) throw new Error('The map workspace needs a 2D canvas.');
  const context = surface;
  const events = new AbortController();
  const options = { signal: events.signal };
  let state = app.snapshot();
  let cellSize = 16,
    fittedSize = 16;
  let pointerId: number | null = null;
  let alive = true;
  const images = new Map<string, HTMLImageElement>();
  const padding = 20;
  function fit(): void {
    fittedSize = Math.max(
      2,
      Math.min(
        48,
        (viewport.clientWidth - padding * 2 - 4) / state.map.width,
        (viewport.clientHeight - padding * 2 - 4) / state.map.height,
      ),
    );
    cellSize = fittedSize;
    viewport.scrollTo(0, 0);
    draw();
  }
  function draw(): void {
    const map = state.map,
      width = map.width * cellSize + padding * 2,
      height = map.height * cellSize + padding * 2;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const pixelsW = Math.round(width * ratio),
      pixelsH = Math.round(height * ratio);
    if (canvas.width !== pixelsW || canvas.height !== pixelsH) {
      canvas.width = pixelsW;
      canvas.height = pixelsH;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#101215';
    context.fillRect(0, 0, width, height);
    const sx = (x: number) => padding + x * cellSize;
    const sy = (y: number) => padding + (map.height - y) * cellSize;
    const scenario = themeByID(state.content, map.theme);
    context.fillStyle = scenario.planFloor;
    context.fillRect(padding, padding, map.width * cellSize, map.height * cellSize);
    for (const decal of map.decals ?? []) {
      const asset = state.content.decals.find((d) => d.id === decal.asset);
      if (!asset) continue;
      let image = images.get(asset.texture);
      if (!image) {
        image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
          if (alive) draw();
        };
        image.src = contentURL(asset.texture);
        images.set(asset.texture, image);
      }
      if (!image.complete || !image.naturalWidth) continue;
      context.save();
      context.translate(sx(decal.x), sy(decal.y));
      context.rotate(decal.angle);
      context.globalAlpha = decal.opacity;
      context.drawImage(
        image,
        (-decal.w * cellSize) / 2,
        (-decal.h * cellSize) / 2,
        decal.w * cellSize,
        decal.h * cellSize,
      );
      context.restore();
    }
    for (const w of map.walls) {
      const level = w.height ?? 0.7;
      context.fillStyle = `hsl(${scenario.materials[w.material ?? scenario.defaultMaterial]!.wallHue} 15% ${Math.min(69, 27 + level * 7)}%)`;
      context.fillRect(sx(w.x), sy(w.y + w.h), w.w * cellSize, w.h * cellSize);
      if (cellSize >= 15) {
        context.fillStyle = '#e7edf3';
        context.font = `${Math.min(13, cellSize * 0.5)}px system-ui`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        for (let y = w.y; y < w.y + w.h; y++)
          for (let x = w.x; x < w.x + w.w; x++)
            context.fillText(String(level), sx(x + 0.5), sy(y + 0.5));
      }
    }
    context.fillStyle = '#eead4c55';
    for (const p of state.report.unreachable)
      context.fillRect(sx(p.x), sy(p.y + 1), cellSize, cellSize);
    if (cellSize >= 5) {
      context.strokeStyle = '#11182088';
      context.lineWidth = 0.6;
      context.beginPath();
      for (let x = 0; x <= map.width; x++) {
        context.moveTo(sx(x), padding);
        context.lineTo(sx(x), sy(0));
      }
      for (let y = 0; y <= map.height; y++) {
        context.moveTo(padding, sy(y));
        context.lineTo(sx(map.width), sy(y));
      }
      context.stroke();
    }
    map.spawns.forEach((p, index) => {
      if (p.x < 0 || p.y < 0 || p.x > map.width || p.y > map.height) return;
      context.beginPath();
      context.arc(sx(p.x), sy(p.y), Math.max(3, cellSize * 0.37), 0, Math.PI * 2);
      context.fillStyle = '#ff4040';
      context.fill();
      context.strokeStyle = '#32160c';
      context.stroke();
      if (cellSize >= 12) {
        context.fillStyle = '#160f0c';
        context.font = `bold ${Math.max(9, cellSize * 0.48)}px system-ui`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(String(index + 1), sx(p.x), sy(p.y));
      }
    });
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2;
    const selected = state.selectedDecal === null ? undefined : map.decals?.[state.selectedDecal];
    if (selected) {
      context.save();
      context.translate(sx(selected.x), sy(selected.y));
      context.rotate(selected.angle);
      context.strokeRect(
        (-selected.w * cellSize) / 2,
        (-selected.h * cellSize) / 2,
        selected.w * cellSize,
        selected.h * cellSize,
      );
      context.restore();
    }
    for (const p of mirrorCells(map, state.cursor, state.symmetry))
      if (p.x >= 0 && p.y >= 0 && p.x < map.width && p.y < map.height)
        context.strokeRect(sx(p.x) + 1, sy(p.y + 1) + 1, cellSize - 2, cellSize - 2);
    context.fillStyle = '#9ba5b3';
    context.font = '10px system-ui';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillText('0, 0', padding, height - 8);
    context.textAlign = 'right';
    context.fillText(`${map.width}, ${map.height}`, width - padding, 9);
    app.zoom(Math.round((cellSize / fittedSize) * 100));
  }
  function cell(event: PointerEvent): Vec2 | null {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left - padding) / cellSize);
    const y = state.map.height - 1 - Math.floor((event.clientY - rect.top - padding) / cellSize);
    return x >= 0 && y >= 0 && x < state.map.width && y < state.map.height ? { x, y } : null;
  }
  function location(event: PointerEvent): Vec2 {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - rect.left - padding) / cellSize) * 20) / 20,
      y: Math.round((state.map.height - (event.clientY - rect.top - padding) / cellSize) * 20) / 20,
    };
  }

  function finishStroke() {
    const pointer = pointerId;
    pointerId = null;
    if (pointer !== null && canvas.hasPointerCapture(pointer))
      canvas.releasePointerCapture(pointer);
    app.finishStroke();
  }
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 && event.button !== 2) return;
      const point = cell(event);
      if (!point) return;
      event.preventDefault();
      canvas.focus();
      finishStroke();
      if (state.tool === 'decal') {
        const position = location(event);
        if (event.button === 2) {
          app.deleteDecal(decalAt(state.map, position));
          return;
        }
        app.beginDecalDrag(position);
        pointerId = event.pointerId;
        canvas.setPointerCapture(pointerId);
        return;
      }
      app.beginStroke(event.button === 2 ? 'erase' : state.tool);
      pointerId = event.pointerId;
      canvas.setPointerCapture(pointerId);
      app.paintAt(point);
    },
    options,
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      const point = cell(event);
      if (!point) {
        app.breakStroke();
        return;
      }
      if (pointerId !== null) {
        if (state.tool === 'decal') app.moveDecal(location(event));
        else app.paintAt(point);
      } else app.cursor(point);
    },
    options,
  );
  canvas.addEventListener('pointerup', finishStroke, options);
  canvas.addEventListener('pointercancel', finishStroke, options);
  canvas.addEventListener('lostpointercapture', finishStroke, options);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);
  window.addEventListener('blur', finishStroke, options);
  window.addEventListener(
    'keydown',
    (event) => {
      if (
        state.trial ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
        event.preventDefault();
        finishStroke();
        if (event.shiftKey) app.redo();
        else app.undo();
        return;
      }
      const shortcuts: Record<string, Tool> = {
        Digit1: 'wall',
        Digit2: 'floor',
        Digit3: 'spawn',
        Digit4: 'erase',
        Digit5: 'decal',
      };
      const shortcut = shortcuts[event.code];
      if (shortcut) {
        event.preventDefault();
        finishStroke();
        app.selectTool(shortcut);
      }
      if (event.target !== canvas) return;
      if (event.code === 'Delete' && state.tool === 'decal') {
        event.preventDefault();
        app.deleteDecal();
        return;
      }
      const moves: Record<string, Vec2> = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: 1 },
        ArrowDown: { x: 0, y: -1 },
      };
      const move = moves[event.code];
      if (move) {
        event.preventDefault();
        app.cursor({
          x: Math.max(0, Math.min(state.map.width - 1, state.cursor.x + move.x)),
          y: Math.max(0, Math.min(state.map.height - 1, state.cursor.y + move.y)),
        });
      }
      if (event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat) app.paintCursor();
      }
    },
    options,
  );
  let fitRevision = -1;
  const unsubscribe = app.subscribe((value) => {
    state = value;
    if (state.trial) return;
    if (state.fitRevision !== fitRevision) {
      fitRevision = state.fitRevision;
      fit();
    } else draw();
  });
  const resize = new ResizeObserver(() => {
    if (!state.trial) fit();
  });
  resize.observe(viewport);
  return {
    zoom(factor: number) {
      cellSize = Math.max(2, Math.min(64, cellSize * factor));
      draw();
    },
    dispose() {
      alive = false;
      finishStroke();
      unsubscribe();
      resize.disconnect();
      events.abort();
    },
  };
}
