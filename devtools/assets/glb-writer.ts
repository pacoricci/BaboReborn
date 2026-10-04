// Minimal deterministic GLB writer for the project's authored geometry contract.
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
export function modelGLB(root: TransformNode): Buffer {
  const chunks: Buffer[] = [];
  const views: object[] = [],
    accessors: object[] = [],
    materials: object[] = [],
    meshes: object[] = [];
  const nodes: {
    name: string;
    children?: number[];
    mesh?: number;
    translation?: number[];
    extras?: object;
  }[] = [];
  let byteLength = 0;
  function accessor(values: number[], components: number, indices = false) {
    const encoded = indices ? new Uint32Array(values) : new Float32Array(values);
    const bytes = Buffer.from(encoded.buffer);
    // Bounds describe the stored values; discard platform-specific float64 rounding here too.
    const stored = Array.from(encoded);
    views.push({
      buffer: 0,
      byteOffset: byteLength,
      byteLength: bytes.length,
      target: indices ? 34963 : 34962,
    });
    chunks.push(bytes);
    byteLength += bytes.length;
    accessors.push({
      bufferView: views.length - 1,
      componentType: indices ? 5125 : 5126,
      count: values.length / components,
      type: components === 3 ? 'VEC3' : components === 2 ? 'VEC2' : 'SCALAR',
      min: Array.from({ length: components }, (_, c) =>
        Math.min(...stored.filter((_, i) => i % components === c)),
      ),
      max: Array.from({ length: components }, (_, c) =>
        Math.max(...stored.filter((_, i) => i % components === c)),
      ),
    });
    return accessors.length - 1;
  }
  const groups: [string, TransformNode][] = [
    ['static', root],
    ...root
      .getChildTransformNodes(true)
      .map(
        (n) =>
          [['rotor', 'charge'].find((p) => n.name.endsWith(`-${p}`)) ?? n.name, n] as [
            string,
            TransformNode,
          ],
      ),
  ];
  for (const [part, group] of groups) {
    const origin = part === 'static' ? Vector3.Zero() : group.position;
    const groupIndex = nodes.length;
    nodes.push({
      name: part,
      children: [],
      translation: [-origin.x, origin.y, origin.z],
      extras: part === 'charge' ? { pivot: group.getPivotPoint().asArray() } : {},
    });
    for (const mesh of group.getChildMeshes(true)) {
      const mat = mesh.material as StandardMaterial | PBRMaterial;
      const positions = Array.from(mesh.getVerticesData('position')!);
      const normals = Array.from(mesh.getVerticesData('normal')!);
      const local = mesh
        .computeWorldMatrix(true)
        .multiply(Matrix.Invert(group.computeWorldMatrix(true)));
      for (let i = 0; i < positions.length; i += 3) {
        const p = Vector3.TransformCoordinates(Vector3.FromArray(positions, i), local);
        const n = Vector3.TransformNormal(Vector3.FromArray(normals, i), local).normalize();
        positions[i] = -p.x;
        positions[i + 1] = p.y;
        positions[i + 2] = p.z;
        normals[i] = -n.x;
        normals[i + 1] = n.y;
        normals[i + 2] = n.z;
      }
      const uv = mesh.getVerticesData('uv');
      const indices = Array.from(mesh.getIndices()!);
      const pbr = mat instanceof PBRMaterial;
      const color = (pbr ? mat.albedoColor : mat.diffuseColor).asArray(),
        emissive = mat.emissiveColor.asArray();
      materials.push({
        name: mat.name,
        pbrMetallicRoughness: {
          baseColorFactor: [...color, 1],
          metallicFactor: pbr ? (mat.metallic ?? 1) : 0,
          roughnessFactor: pbr ? (mat.roughness ?? 1) : 0.8,
        },
        emissiveFactor: emissive,
        ...(!pbr
          ? {
              extras: {
                standard: { diffuse: color, emissive, specular: mat.specularColor.asArray() },
              },
            }
          : {}),
      });
      meshes.push({
        name: `${part}:${mat.name}`,
        primitives: [
          {
            attributes: {
              POSITION: accessor(positions, 3),
              NORMAL: accessor(normals, 3),
              ...(uv ? { TEXCOORD_0: accessor(Array.from(uv), 2) } : {}),
            },
            indices: accessor(indices, 1, true),
            material: materials.length - 1,
          },
        ],
      });
      nodes[groupIndex]!.children!.push(nodes.length);
      nodes.push({ name: `${part}:${mat.name}`, mesh: meshes.length - 1 });
    }
  }
  const doc = {
    asset: { version: '2.0', generator: 'BaboReborn model geometry recipes' },
    scene: 0,
    scenes: [{ nodes: nodes.flatMap((n, i) => (n.children ? [i] : [])) }],
    nodes,
    meshes,
    materials,
    buffers: [{ byteLength }],
    bufferViews: views,
    accessors,
  };
  const json = Buffer.from(JSON.stringify(doc));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const header = Buffer.alloc(20),
    binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + padded.length + byteLength, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(byteLength, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binHeader, ...chunks]);
}
