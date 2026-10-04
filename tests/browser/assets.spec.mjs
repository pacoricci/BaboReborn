import { test, expect } from '@playwright/test';

test('all bundled theme textures decode and models arrive gzip-compressed', async ({ page }) => {
  await page.goto('/play.html');
  const result = await page.evaluate(async () => {
    const catalog = await (await fetch('/content/v1/catalog')).json();
    const paths = new Set();
    for (const theme of catalog.themes) {
      paths.add(theme.floor);
      if (theme.earth) paths.add(theme.earth);
      for (const material of Object.values(theme.materials)) {
        paths.add(material.wall);
        paths.add(material.top);
      }
    }
    const textures = [];
    for (const path of paths) {
      const response = await fetch(`${catalog.fileOrigin}${path}`);
      const image = await createImageBitmap(await response.blob());
      textures.push({
        path,
        status: response.status,
        type: response.headers.get('content-type'),
        width: image.width,
        height: image.height,
      });
      image.close();
    }
    const model = await fetch('/assets/kit/models/knives.glb');
    const bytes = await model.arrayBuffer();
    return {
      textures,
      encoding: model.headers.get('content-encoding'),
      magic: new DataView(bytes).getUint32(0, true),
    };
  });
  expect(result.textures).toHaveLength(19);
  for (const texture of result.textures) {
    expect(texture.status).toBe(200);
    expect(texture.type).toBe('image/webp');
    expect(texture.width).toBeGreaterThan(0);
    expect(texture.width).toBeLessThanOrEqual(1024);
    expect(texture.height).toBeLessThanOrEqual(1024);
  }
  expect(result.encoding).toBe('gzip');
  expect(result.magic).toBe(0x46546c67);
});
