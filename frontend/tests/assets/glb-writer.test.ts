import test from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { modelGLB } from '../../../devtools/assets/glb-writer';

void test('GLB accessor bounds match the encoded vertex precision', () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const root = new TransformNode('fixture', scene);
    const mesh = new Mesh('triangle', scene);
    mesh.parent = root;
    mesh.material = new StandardMaterial('fixture', scene);
    const data = new VertexData();
    data.positions = [0.1, -0.2, 0, 0.3, 0.4, 0, -0.5, 0.6, 0];
    data.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    data.uvs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    data.indices = [0, 1, 2];
    data.applyToMesh(mesh);
    const glb = modelGLB(root);
    const jsonLength = glb.readUInt32LE(12);
    const doc = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength)) as {
      accessors: {
        bufferView: number;
        componentType: number;
        count: number;
        min: number[];
        max: number[];
      }[];
      bufferViews: { byteOffset: number }[];
    };
    for (const accessor of doc.accessors) {
      const offset = 28 + jsonLength + doc.bufferViews[accessor.bufferView]!.byteOffset;
      const components = accessor.min.length;
      for (let c = 0; c < components; c++) {
        const values = Array.from({ length: accessor.count }, (_, i) => {
          const at = offset + (i * components + c) * 4;
          return accessor.componentType === 5126 ? glb.readFloatLE(at) : glb.readUInt32LE(at);
        });
        // JSON writes both signed zeros as 0.
        assert.equal(accessor.min[c], Math.min(...values) + 0);
        assert.equal(accessor.max[c], Math.max(...values) + 0);
      }
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
