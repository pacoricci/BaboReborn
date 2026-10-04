import { buildWorld } from './build-world.ts';
import { buildPrimaries } from './build-primaries.ts';
// Procedural authoring recipes; runtime discovery reads package manifests.
const SKIN_RECIPES = [
  'geometric',
  'bands',
  'chevron',
  'diamonds',
  'hexagons',
  'triangles',
  'checkerboard',
  'rings',
  'starburst',
  'circuit',
  'hazard',
  'armor',
  'camo',
  'tiger',
  'fracture',
];
// Authoring source: deterministic glTF geometry and procedural skin rasterization.
// No assets from the reference game are read by this tool.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const root = new URL('../../', import.meta.url);
// A tiny PNG writer keeps this editable geometric skin independent of image libraries.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, bytes) {
  const content = Buffer.concat([Buffer.from(type), bytes]),
    header = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  crc.writeUInt32BE(crc32(content));
  return Buffer.concat([header, content, crc]);
}
// Project subdivided icosahedron edges into UVs instead of drawing latitude lines.
const normalize = (p) => {
  const length = Math.hypot(...p);
  return p.map((v) => v / length);
};
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const t = (1 + Math.sqrt(5)) / 2;
const vertices = [
  [-1, t, 0],
  [1, t, 0],
  [-1, -t, 0],
  [1, -t, 0],
  [0, -1, t],
  [0, 1, t],
  [0, -1, -t],
  [0, 1, -t],
  [t, 0, -1],
  [t, 0, 1],
  [-t, 0, -1],
  [-t, 0, 1],
].map(normalize);
const faces = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
];
const edges = [];
for (const face of faces) {
  const [a, b, c] = face.map((i) => vertices[i]);
  const ab = normalize(a.map((v, i) => v + b[i])),
    bc = normalize(b.map((v, i) => v + c[i])),
    ca = normalize(c.map((v, i) => v + a[i]));
  for (const [u, v] of [
    [a, ab],
    [ab, b],
    [b, bc],
    [bc, c],
    [c, ca],
    [ca, a],
    [ab, bc],
    [bc, ca],
    [ca, ab],
  ]) {
    edges.push({ a: u, b: v, normal: normalize(cross(u, v)), cos: dot(u, v) });
  }
}
const width = 512,
  height = 256,
  mask = new Float32Array(width * height);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const phi = (y / (height - 1)) * Math.PI,
      theta = (x / width) * Math.PI * 2;
    const p = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
    let distance = 1;
    for (const edge of edges) {
      if (dot(p, edge.a) < edge.cos || dot(p, edge.b) < edge.cos) continue;
      distance = Math.min(distance, Math.abs(dot(p, edge.normal)));
    }
    mask[y * width + x] = Math.max(0, Math.min(1, (0.012 - distance) / 0.006));
  }

const panelCenters = faces.map((face) =>
  normalize([0, 1, 2].map((axis) => face.reduce((sum, i) => sum + vertices[i][axis], 0))),
);
const hexCenters = [...new Map(edges.map(({ a }) => [a.join(','), a])).values()];
// Uneven, deterministic sites make fractured plates distinct from regular tiles.
const fractureCenters = Array.from({ length: 28 }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / 28,
    angle = i * Math.PI * (3 - Math.sqrt(5)) + Math.sin(i * 7.3) * 0.4,
    radius = Math.sqrt(1 - y * y);
  return [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
});
const fract = (value) => value - Math.floor(value);
const stripe = (value) => Math.floor(fract(value) * 3);

// Evaluate on the sphere rather than across a flat image seam. The Voronoi cells
// include twelve pentagons: a sphere cannot be tiled with hexagons alone.
function geometricRegion(name, phi, theta) {
  const p = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
  const u = theta / (Math.PI * 2),
    v = phi / Math.PI;
  switch (name) {
    case 'hazard': {
      const band = fract((p[0] * 0.8 + p[1] * 0.6) * 3.2);
      return band < 0.08 ? 2 : band < 0.54 ? 0 : 1;
    }
    case 'armor': {
      // Riveted cube-face plates retain broad details at either pole.
      const axis = p.map(Math.abs).indexOf(Math.max(...p.map(Math.abs)));
      const [a, b] = p.filter((_, i) => i !== axis).map((n) => n / Math.abs(p[axis]));
      const x = fract((a + 1) * 1.5),
        y = fract((b + 1) * 1.5),
        edge = Math.min(x, 1 - x, y, 1 - y);
      if (Math.hypot(Math.abs(x - 0.5) - 0.32, Math.abs(y - 0.5) - 0.32) < 0.065) return 2;
      return edge < 0.075 ? 1 : 0;
    }
    case 'camo': {
      const patch =
        Math.sin(p[0] * 13 + Math.sin(p[2] * 9) * 1.8) +
        Math.sin(p[1] * 11 - p[2] * 7) +
        Math.cos(p[2] * 12 + p[0] * 5);
      return patch < -0.55 ? 1 : patch > 0.8 ? 2 : 0;
    }
    case 'tiger': {
      const wave = Math.sin(p[0] * 23 + Math.sin(p[1] * 10 + p[2] * 6) * 2.4),
        width = 0.48 + Math.sin(p[1] * 7 - p[2] * 9) * 0.22;
      return wave > width ? 1 : wave > width - 0.2 ? 2 : 0;
    }
    case 'fracture': {
      let nearest = -Infinity,
        second = -Infinity,
        index = 0;
      fractureCenters.forEach((center, i) => {
        const distance = dot(p, center);
        if (distance > nearest) {
          second = nearest;
          nearest = distance;
          index = i;
        } else second = Math.max(second, distance);
      });
      return nearest - second < 0.025 ? 2 : index % 3 === 0 ? 1 : 0;
    }
    case 'hexagons':
    case 'triangles': {
      const centers = name === 'hexagons' ? hexCenters : panelCenters;
      let nearest = -Infinity,
        second = -Infinity,
        index = 0;
      centers.forEach((center, i) => {
        const distance = dot(p, center);
        if (distance > nearest) {
          second = nearest;
          nearest = distance;
          index = i;
        } else second = Math.max(second, distance);
      });
      return nearest - second < 0.018 ? 2 : index % 2;
    }
    case 'chevron':
      return stripe(v * 4 + Math.abs(fract(u * 8) - 0.5) * 1.4);
    case 'diamonds': {
      if (Math.abs(p[1]) > 0.96) return 2;
      const a = u * 8 + v * 4,
        b = u * 8 - v * 4;
      return Math.min(fract(a), fract(b)) < 0.1 ? 2 : (Math.floor(a) + Math.floor(b) + 8) % 2;
    }
    case 'checkerboard':
      if (Math.abs(p[1]) > 0.96) return 2;
      return Math.min(fract(u * 12), fract(v * 6)) < 0.08
        ? 2
        : (Math.floor(u * 12) + Math.floor(v * 6)) % 2;
    case 'rings':
      return stripe(Math.acos(Math.min(1, Math.max(...p.map(Math.abs)))) * 2.5);
    case 'starburst': {
      const ray = Math.abs(fract(u * 10) - 0.5) * 2;
      const pole = Math.min(v, 1 - v);
      if (pole < 0.1 + ray * 0.28) return 2;
      return fract(u * 10) < 0.5 ? 0 : 1;
    }
    case 'circuit': {
      // Cube-face coordinates keep tracks broad at the poles and on every side.
      const axis = p.map(Math.abs).indexOf(Math.max(...p.map(Math.abs)));
      const [a, b] = p.filter((_, i) => i !== axis).map((n) => n / Math.abs(p[axis]));
      const dx = Math.abs(fract((a + 1) * 2) - 0.5),
        dy = Math.abs(fract((b + 1) * 2) - 0.5);
      if (Math.hypot(dx, dy) < 0.16) return 2;
      return Math.min(dx, dy) < 0.055 ? 1 : 0;
    }
    default:
      throw new Error(`Unknown geometric template: ${name}`);
  }
}

function template(name) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const line = mask[y * width + x],
        i = y * (width * 3 + 1) + 1 + x * 3;
      const phi = (y / (height - 1)) * Math.PI,
        theta = (x / width) * Math.PI * 2;
      // Seamless spherical regions: panel infill + narrow seams; broad tilted bands.
      const panel = Math.sin(phi) * Math.cos(theta) * Math.cos(phi) > 0 ? 1 : 0;
      const wave = Math.sin(7 * (Math.cos(phi) * 0.8 + Math.sin(phi) * Math.cos(theta) * 0.6));
      const band = wave > 0.28 ? 0 : wave < -0.28 ? 1 : 2;
      let weights;
      if (name === 'geometric') weights = [panel * (1 - line), (1 - panel) * (1 - line), line];
      else if (name === 'bands')
        weights = [Number(band === 0), Number(band === 1), Number(band === 2)];
      else {
        weights = [0, 0, 0];
        // Four samples soften mask edges; runtime palette mixing remains unchanged.
        for (const dy of [-0.25, 0.25])
          for (const dx of [-0.25, 0.25]) {
            const region = geometricRegion(
              name,
              (Math.max(0, Math.min(height - 1, y + dy)) / (height - 1)) * Math.PI,
              ((x + dx + width) / width) * Math.PI * 2,
            );
            weights[region] += 0.25;
          }
      }
      for (let c = 0; c < 3; c++) raw[i + c] = Math.round(weights[c] * 255);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  writeFileSync(
    new URL(`content/skins/${name}/mask.png`, root),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(raw)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

for (const id of SKIN_RECIPES) template(id);

console.log(`Built ${SKIN_RECIPES.length} three-channel skin templates.`);

buildPrimaries();

buildWorld();
