import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
const target = new URL('../../backend/web/dist/', import.meta.url);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(new URL('../../dist/', import.meta.url), target, { recursive: true });

const portal = new URL('../../backend/web/portal/', import.meta.url);
rmSync(portal, { recursive: true, force: true });
mkdirSync(portal, { recursive: true });
for (const name of ['home.html', 'account.html', 'management.html', 'account.js']) {
  cpSync(new URL(`../../frontend/src/apps/portal/${name}`, import.meta.url), new URL(name, portal));
}
cpSync(
  new URL('../../frontend/src/ui/product.css', import.meta.url),
  new URL('product.css', portal),
);
cpSync(new URL('../../frontend/src/ui/topbar.css', import.meta.url), new URL('topbar.css', portal));
cpSync(
  new URL('../../frontend/src/apps/management/style.css', import.meta.url),
  new URL('management.css', portal),
);

const manifest = JSON.parse(
  readFileSync(new URL('../../dist/.vite/manifest.json', import.meta.url), 'utf8'),
);
const registry = manifest['frontend/src/apps/portal/registry.tsx'].file;
const management = new URL('management.html', portal);
writeFileSync(
  management,
  readFileSync(management, 'utf8').replace('/assets/registry.js', `/${registry}`),
);

// Compress once during the build, keeping decompression transparent to browsers.
const { readdirSync, statSync } = await import('node:fs');
const { gzipSync } = await import('node:zlib');
function precompress(directory) {
  for (const name of readdirSync(directory)) {
    const file = new URL(name, directory);
    if (statSync(file).isDirectory()) {
      precompress(new URL(`${name}/`, directory));
    } else if (/\.(js|css|json|svg|glb|wav|ttf)$/.test(name)) {
      const original = readFileSync(file);
      const compressed = gzipSync(original, { level: 9 });
      if (compressed.length < original.length)
        writeFileSync(new URL(`${name}.gz`, directory), compressed);
    }
  }
}
precompress(target);
