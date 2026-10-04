import type { Catalog, Theme } from '../../content/types';
import { themeByID } from '../../content/types';
import type { Vec2 } from '../../core/geometry';
import type { ArenaMap, MapDecal } from '../../maps/types';
import { decalAt, placeDecal, changeDecal, removeDecal } from './decals';
import {
  EditorHistory,
  exportMap,
  inspectMap,
  MAX_MAP_BYTES,
  newMap,
  paint,
  parseMap,
  resizeMap,
  strokeCells,
} from './model';
import type { MapReport, Symmetry, Tool } from './model';

export type TrialFactory = (
  map: ArenaMap,
  spawn: number,
  content: Catalog,
  status: (message: string) => void,
  exit: () => void,
) => () => void;
interface EditorPorts {
  download(name: string, source: string): void;
  prepareTrial(): Promise<TrialFactory>;
}
interface EditorState {
  decalAsset: string;
  selectedDecal: number | null;
  map: ArenaMap;
  content: Catalog;
  report: MapReport;
  tool: Tool;
  symmetry: Symmetry;
  wallHeight: number;
  material: string;
  cursor: Vec2;
  zoom: number;
  spawn: number;
  canUndo: boolean;
  canRedo: boolean;
  notice: string;
  reading: boolean;
  trialLoading: boolean;
  trial: boolean;
  trialStatus: string;
  fieldsRevision: number;
  fitRevision: number;
}

/** Owns the document and async commands; views never create a history or trial on mount. */
export class EditorApplication {
  private history = new EditorHistory(newMap());
  private installedHistory: EditorHistory | undefined;
  private saved = JSON.stringify(this.history.current);
  private state: EditorState;
  private readonly listeners = new Set<(state: EditorState) => void>();
  private generation = 0;
  private disposed = false;
  private stopTrial: (() => void) | undefined;
  private strokeTool: Tool | null = null;
  private previousCell: Vec2 | null = null;
  private decalDrag: { index: number; offset: Vec2 } | undefined;
  constructor(
    readonly installed: Catalog,
    readonly maps: readonly ArenaMap[],
    private readonly ports: EditorPorts,
  ) {
    this.state = {
      decalAsset: installed.decals[0]?.id ?? '',
      selectedDecal: null,
      map: this.history.current,
      content: installed,
      report: inspectMap(this.history.current),
      tool: 'wall',
      symmetry: 'none',
      wallHeight: 3,
      material: themeByID(installed, this.history.current.theme).defaultMaterial,
      cursor: { x: 2, y: 2 },
      zoom: 100,
      spawn: 0,
      canUndo: false,
      canRedo: false,
      notice: '',
      reading: false,
      trialLoading: false,
      trial: false,
      trialStatus: '',
      fieldsRevision: 0,
      fitRevision: 0,
    };
  }
  snapshot(): EditorState {
    return this.state;
  }
  subscribe(listener: (state: EditorState) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(patch: Partial<EditorState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
  private invalidate(): void {
    ++this.generation;
    if (this.state.reading || this.state.trialLoading)
      this.publish({
        reading: false,
        trialLoading: false,
        notice: 'Pending load cancelled by a newer action.',
      });
  }
  private sync(fields = false, fit = false): void {
    const map = this.history.current;
    const theme = themeByID(this.state.content, map.theme);
    this.publish({
      map,
      selectedDecal:
        !fit && this.state.selectedDecal !== null && map.decals?.[this.state.selectedDecal]
          ? this.state.selectedDecal
          : null,
      report: inspectMap(map),
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      material: Object.hasOwn(theme.materials, this.state.material)
        ? this.state.material
        : theme.defaultMaterial,
      spawn: Math.min(this.state.spawn, Math.max(0, map.spawns.length - 1)),
      fieldsRevision: this.state.fieldsRevision + Number(fields),
      fitRevision: this.state.fitRevision + Number(fit),
    });
  }
  private commit(map: ArenaMap, fit = false): void {
    if (this.disposed || this.state.trial) return;
    const theme = themeByID(this.state.content, map.theme);
    for (const wall of map.walls)
      if (wall.material && !Object.hasOwn(theme.materials, wall.material))
        throw new Error(`Unknown wall material: ${wall.material}`);
    this.validateDecalAssets(map);
    this.finishStroke();
    this.invalidate();
    this.history.change(map);
    this.history.finish();
    this.sync(true, fit);
  }
  notice(message: string): void {
    this.publish({ notice: message });
  }
  fit(): void {
    this.publish({ fitRevision: this.state.fitRevision + 1 });
  }
  zoom(value: number): void {
    if (value !== this.state.zoom) this.publish({ zoom: value });
  }
  cursor(point: Vec2): void {
    if (point.x !== this.state.cursor.x || point.y !== this.state.cursor.y)
      this.publish({ cursor: { ...point } });
  }
  selectTool(tool: Tool): void {
    this.finishStroke();
    this.publish({ tool });
  }
  selectSymmetry(symmetry: Symmetry): void {
    this.finishStroke();
    this.publish({ symmetry });
  }
  selectHeight(wallHeight: number): void {
    this.finishStroke();
    this.publish({ wallHeight });
  }
  selectMaterial(material: string): void {
    this.finishStroke();
    if (Object.hasOwn(themeByID(this.state.content, this.state.map.theme).materials, material))
      this.publish({ material });
  }
  selectSpawn(spawn: number): void {
    if (Number.isInteger(spawn) && spawn >= 0 && spawn < this.state.map.spawns.length)
      this.publish({ spawn });
  }
  private validateDecalAssets(map: ArenaMap): void {
    for (const decal of map.decals ?? [])
      if (!this.state.content.decals.some((asset) => asset.id === decal.asset))
        throw new Error(`Unknown decal: ${decal.asset}`);
  }
  selectDecalAsset(asset: string): void {
    this.finishStroke();
    if (this.state.content.decals.some((d) => d.id === asset))
      this.publish({ decalAsset: asset, tool: 'decal', selectedDecal: null });
  }
  beginDecalDrag(point: Vec2): void {
    if (this.disposed || this.state.trial) return;
    this.finishStroke();
    this.invalidate();
    this.history.begin();
    let index = decalAt(this.state.map, point);
    try {
      if (index < 0) {
        if (!this.state.decalAsset) throw new Error('Choose a decal first.');
        this.history.change(
          placeDecal(this.state.map, {
            asset: this.state.decalAsset,
            x: point.x,
            y: point.y,
            w: 2,
            h: 2,
            angle: 0,
            opacity: 0.6,
          }),
        );
        index = this.history.current.decals!.length - 1;
      }
      const decal = this.history.current.decals![index]!;
      this.decalDrag = { index, offset: { x: point.x - decal.x, y: point.y - decal.y } };
      this.strokeTool = 'decal';
      this.publish({ map: this.history.current, selectedDecal: index });
    } catch (error) {
      this.history.finish();
      this.notice(error instanceof Error ? error.message : 'Could not place decal.');
    }
  }
  moveDecal(point: Vec2): void {
    if (!this.decalDrag) return;
    const { index, offset } = this.decalDrag;
    try {
      this.history.change(
        changeDecal(this.history.current, index, { x: point.x - offset.x, y: point.y - offset.y }),
      );
      this.publish({ map: this.history.current });
    } catch {
      /* Keep the last valid footprint while dragging beyond the map. */
    }
  }
  updateDecal(patch: Partial<MapDecal>): void {
    this.finishStroke();
    const index = this.state.selectedDecal;
    if (index === null) return;
    try {
      this.commit(changeDecal(this.state.map, index, patch));
    } catch (error) {
      this.notice(error instanceof Error ? error.message : 'Could not update decal.');
      this.sync();
    }
  }
  duplicateDecal(): void {
    const decal =
      this.state.selectedDecal === null
        ? undefined
        : this.state.map.decals?.[this.state.selectedDecal];
    if (!decal) return;
    try {
      this.commit(placeDecal(this.state.map, { ...decal }));
      this.publish({ selectedDecal: this.state.map.decals!.length - 1 });
    } catch (error) {
      this.notice(error instanceof Error ? error.message : 'Could not duplicate decal.');
    }
  }
  deleteDecal(index = this.state.selectedDecal): void {
    this.finishStroke();
    if (index === null || index < 0) return;
    this.commit(removeDecal(this.state.map, index));
    this.publish({ selectedDecal: null });
  }
  beginStroke(tool = this.state.tool): void {
    if (this.disposed || this.state.trial) return;
    this.finishStroke();
    this.invalidate();
    this.history.begin();
    this.strokeTool = tool;
  }
  paintAt(point: Vec2): void {
    if (!this.strokeTool || this.disposed) return;
    for (const cell of strokeCells(this.previousCell ?? point, point))
      this.history.change(
        paint(
          this.history.current,
          cell,
          this.strokeTool,
          this.state.wallHeight,
          this.state.symmetry,
          this.state.material,
        ),
      );
    this.previousCell = { ...point };
    // Connectivity validation waits for the completed stroke, not each pointer sample.
    this.publish({ map: this.history.current, cursor: { ...point } });
  }
  breakStroke(): void {
    this.previousCell = null;
  }
  finishStroke(): void {
    if (!this.strokeTool) return;
    this.strokeTool = null;
    this.previousCell = null;
    this.decalDrag = undefined;
    this.history.finish();
    this.sync();
  }
  paintCursor(): void {
    if (this.state.tool === 'decal') {
      this.beginDecalDrag({ x: this.state.cursor.x + 0.5, y: this.state.cursor.y + 0.5 });
      this.finishStroke();
      return;
    }
    this.beginStroke();
    this.paintAt(this.state.cursor);
    this.finishStroke();
  }
  undo(): void {
    this.finishStroke();
    this.invalidate();
    this.history.undo();
    this.publish({ selectedDecal: null });
    this.sync(true);
    this.notice('Undid the last edit.');
  }
  redo(): void {
    this.finishStroke();
    this.invalidate();
    this.history.redo();
    this.publish({ selectedDecal: null });
    this.sync(true);
    this.notice('Restored the edit.');
  }
  removeSpawn(index: number): void {
    this.commit({ ...this.state.map, spawns: this.state.map.spawns.filter((_, i) => i !== index) });
  }
  newDocument(): void {
    this.commit(newMap(), true);
    this.notice('New arena. Undo returns to your previous map.');
  }
  openCatalog(id: string): void {
    const map = this.maps.find((item) => item.id === id);
    if (map) {
      this.commit(map, true);
      this.notice(`Opened ${map.name}.`);
    }
  }
  properties(value: {
    id: string;
    name: string;
    author: string;
    width: number;
    height: number;
  }): void {
    try {
      this.commit(
        {
          ...resizeMap(this.state.map, value.width, value.height),
          id: value.id.trim(),
          name: value.name.trim(),
          author: value.author.trim(),
        },
        true,
      );
      this.notice('Map settings applied.');
    } catch (error) {
      this.notice(error instanceof Error ? error.message : 'Could not update the map.');
    }
  }
  theme(id: string): void {
    if (!this.state.content.themes.some((theme) => theme.id === id)) return;
    this.commit({
      ...this.state.map,
      theme: id,
      walls: this.state.map.walls.map((value) => {
        const wall = { ...value };
        delete wall.material;
        return wall;
      }),
    });
    this.notice(`${themeByID(this.state.content, id).name} applied. Wall materials reset.`);
  }
  preview(theme: Theme | undefined): void {
    this.finishStroke();
    this.invalidate();
    if (theme && !this.installedHistory) this.installedHistory = this.history;
    const content = theme
      ? {
          ...this.installed,
          themes: [...this.installed.themes.filter((t) => t.id !== theme.id), theme],
        }
      : this.installed;
    if (theme)
      this.history = new EditorHistory({
        ...this.state.map,
        theme: theme.id,
        walls: this.state.map.walls.map((value) => {
          const wall = { ...value };
          delete wall.material;
          return wall;
        }),
      });
    else if (this.installedHistory) {
      this.history = this.installedHistory;
      this.installedHistory = undefined;
    }
    this.publish({ content, map: this.history.current });
    this.sync(true);
  }
  async openFile(file: { name: string; size: number; text(): Promise<string> }): Promise<void> {
    this.finishStroke();
    this.invalidate();
    if (file.size > MAX_MAP_BYTES) {
      this.notice('Map files must be no larger than 1 MiB.');
      return;
    }
    const ticket = this.generation;
    this.publish({ reading: true, notice: 'Opening map…' });
    try {
      const source = await file.text();
      if (this.disposed || ticket !== this.generation) return;
      this.publish({ reading: false });
      this.commit(parseMap(source), true);
      this.notice(`Opened ${file.name}. Undo restores the previous map.`);
    } catch (error) {
      if (!this.disposed && ticket === this.generation)
        this.notice(error instanceof Error ? error.message : 'Could not open the map.');
    } finally {
      if (ticket === this.generation) this.publish({ reading: false });
    }
  }
  save(): void {
    this.finishStroke();
    try {
      this.validateDecalAssets(this.state.map);
      const source = exportMap(this.state.map);
      this.ports.download(`${this.state.map.id}.json`, source);
      this.saved = JSON.stringify(this.state.map);
      this.notice(`Saved ${this.state.map.id}.json.`);
    } catch (error) {
      this.notice(error instanceof Error ? error.message : 'Could not export the map.');
    }
  }
  dirty(): boolean {
    return JSON.stringify(this.history.current) !== this.saved;
  }
  async test(): Promise<void> {
    this.finishStroke();
    if (
      this.disposed ||
      this.state.trialLoading ||
      this.state.trial ||
      this.state.report.errors.length
    )
      return;
    this.invalidate();
    const ticket = this.generation;
    const { map, spawn, content } = this.state;
    try {
      this.validateDecalAssets(map);
    } catch (error) {
      this.notice(error instanceof Error ? error.message : 'Unknown decal.');
      return;
    }
    this.publish({ trialLoading: true, notice: 'Loading map…' });
    try {
      const start = await this.ports.prepareTrial();
      if (this.disposed || ticket !== this.generation) return;
      this.publish({ trial: true, trialStatus: '' });
      const stop = start(
        map,
        spawn,
        content,
        (message) => {
          if (ticket === this.generation) this.publish({ trialStatus: message });
        },
        () => this.endTrial(),
      );
      if (this.disposed || ticket !== this.generation) stop();
      else {
        this.stopTrial = stop;
        this.publish({ trialLoading: false, notice: '' });
      }
    } catch (error) {
      if (this.disposed || ticket !== this.generation) return;
      this.endTrial();
      this.notice(error instanceof Error ? error.message : 'Could not start WebGL.');
    }
  }
  endTrial(): void {
    this.invalidate();
    this.stopTrial?.();
    this.stopTrial = undefined;
    this.publish({
      trial: false,
      trialLoading: false,
      trialStatus: '',
      fitRevision: this.state.fitRevision + 1,
    });
  }
  suspend(): void {
    this.finishStroke();
    this.endTrial();
  }
  dispose(): void {
    this.suspend();
    this.disposed = true;
    this.listeners.clear();
  }
}
