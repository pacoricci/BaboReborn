import { roomsPath } from '../../navigation/routes';
import { currentContent, loadMap } from '../../content/runtime';
import { startWithContent } from '../../bootstrap/content';
import { EditorApplication } from './application';
import { mountEditor } from './screen';
import './style.css';

void startWithContent(async () => {
  const maps = await Promise.all(
    currentContent()
      .maps.filter((m) => !m.ctf)
      .map(loadMap),
  );
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
  const events = new AbortController();
  const app = new EditorApplication(currentContent(), maps, {
    download(name, source) {
      const url = URL.createObjectURL(new Blob([source], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      downloads.set(
        url,
        setTimeout(() => {
          URL.revokeObjectURL(url);
          downloads.delete(url);
        }, 1000),
      );
    },
    async prepareTrial() {
      const { startTrial } = await import('./play');
      return (map, spawn, content, status, exit) => {
        const { game, minimap } = ui.canvases();
        return startTrial(game, minimap, map, spawn, status, exit, content);
      };
    },
  });
  const ui = mountEditor(document.getElementById('editor-root')!, app, roomsPath());
  window.addEventListener(
    'beforeunload',
    (event) => {
      if (app.dirty()) {
        event.preventDefault();
        event.returnValue = '';
      }
    },
    { signal: events.signal },
  );
  window.addEventListener(
    'pagehide',
    (event) => {
      for (const [url, timer] of downloads) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloads.clear();
      // Preserve document/history for bfcache, but never resume a disposed local trial.
      if (event.persisted) {
        app.suspend();
        return;
      }
      app.dispose();
      ui.dispose();
      events.abort();
    },
    { signal: events.signal },
  );
});
