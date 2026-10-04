import solid from 'vite-plugin-solid';
import { defineConfig, normalizePath } from 'vite';
import type { Plugin } from 'vite';
import { readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const releaseInputs = {
  credits: 'frontend/src/apps/credits/credits.html',
  privacy: 'frontend/src/apps/legal/privacy.html',
  terms: 'frontend/src/apps/legal/terms.html',
  registry: 'frontend/src/apps/portal/registry.tsx',
  play: 'frontend/src/apps/play/play.html',
  manage: 'frontend/src/apps/management/manage.html',
  match: 'frontend/src/apps/match/match.html',
  editor: 'frontend/src/apps/editor/editor.html',
};

// Public page URLs stay independent of the source directory layout.
function pageRoutes(): Plugin {
  const pages: Record<string, string> = {
    '/credits.html': '/frontend/src/apps/credits/credits.html',
    '/privacy.html': '/frontend/src/apps/legal/privacy.html',
    '/terms.html': '/frontend/src/apps/legal/terms.html',
    '/play.html': '/frontend/src/apps/play/play.html',
    '/manage.html': '/frontend/src/apps/management/manage.html',
    '/match.html': '/frontend/src/apps/match/match.html',
    '/editor.html': '/frontend/src/apps/editor/editor.html',
    '/practice.html': '/frontend/src/apps/practice/practice.html',
  };
  return {
    name: 'page-routes',
    enforce: 'post',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const [path, query] = (request.url ?? '').split('?');
        if (path && pages[path]) request.url = pages[path] + (query ? `?${query}` : '');
        next();
      });
    },
    generateBundle(_options, bundle) {
      for (const [url, source] of Object.entries(pages)) {
        const key = source.slice(1);
        const page = bundle[key];
        if (!page || page.type !== 'asset') continue;
        this.emitFile({ type: 'asset', fileName: url.slice(1), source: page.source });
        delete bundle[key];
      }
    },
  };
}

// Fail the release build if a product entry starts depending on a development surface.
function releaseBoundary(): Plugin {
  let outputDirectory: string;
  const forbiddenModules = [
    '/frontend/src/apps/practice/',
    '/frontend/src/player/development-tools.ts',
    '/devtools/browser/',
  ];
  return {
    name: 'release-boundary',
    apply: 'build',
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      // Public assets are copied verbatim by Vite, including local Finder metadata.
      const clean = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isFile() && entry.name === '.DS_Store') rmSync(path);
          else if (entry.isDirectory()) clean(path);
        }
      };
      clean(outputDirectory);
    },
    generateBundle(_options, bundle) {
      const visited = new Set<string>();
      const visitPlayer = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        if (normalizePath(id).includes('/frontend/src/apps/management/'))
          this.error(`Player entry imports administration: ${id}`);
        const module = this.getModuleInfo(id);
        for (const dependency of [
          ...(module?.importedIds ?? []),
          ...(module?.dynamicallyImportedIds ?? []),
        ])
          visitPlayer(dependency);
      };
      for (const id of this.getModuleIds()) {
        if (/\/frontend\/src\/apps\/(play|match)\/main\.tsx?$/.test(normalizePath(id)))
          visitPlayer(id);
      }
      for (const artifact of Object.values(bundle)) {
        if (artifact.type !== 'chunk') continue;
        for (const moduleID of Object.keys(artifact.modules)) {
          const normalized = normalizePath(moduleID);
          const forbidden = forbiddenModules.find((segment) => normalized.includes(segment));
          if (forbidden) this.error(`Release chunk ${artifact.fileName} includes ${forbidden}`);
        }
      }
    },
  };
}

export default defineConfig({
  publicDir: 'frontend/public',
  plugins: [solid(), pageRoutes(), releaseBoundary()],
  server: {
    // Vite is for authoring tools; multiplayer uses the actual portal and server origins.
    // Only API requests are proxied; authored content imports belong to Vite.
    proxy: { '/content/v1': 'http://127.0.0.1:18090' },
  },
  build: {
    manifest: true,
    rollupOptions: {
      input: releaseInputs,
    },
  },
});
