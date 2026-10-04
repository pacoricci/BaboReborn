import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh';
// One scene-owned asset repository; consumers own transforms, materials overrides and effects.
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Material } from '@babylonjs/core/Materials/material';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MODEL_NAMES, MODEL_DEFINITIONS } from './model-catalog';
import { WeaponTextures } from './weapon-textures';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import '@babylonjs/loaders/glTF/2.0/Extensions/ExtrasAsMetadata';

type Template = { mesh: Mesh; part: string; origin: Vector3; pivot: Vector3 };
type Status = Record<string, 'loading' | 'ready' | 'failed'>;
type Loader = (kind: string) => Promise<AssetContainer>;
type Extras = {
  gltf?: {
    extras?: {
      pivot?: number[];
      standard?: { diffuse: number[]; emissive: number[]; specular: number[] };
    };
  };
};
export class ModelNode extends TransformNode {
  readonly parts = new Map<string, TransformNode>();
  readonly partMeshes = new Map<string, AbstractMesh[]>();
  meshes: AbstractMesh[] = [];
  private overrideMaterial: Material | undefined;
  get material() {
    return this.overrideMaterial;
  }
  set material(value: Material | undefined) {
    if (this.overrideMaterial === value) return;
    if (this.meshes.some((mesh) => mesh instanceof InstancedMesh))
      throw new Error('Request a material override when creating an instanced model');
    this.overrideMaterial = value;
    if (value) for (const mesh of this.meshes) mesh.material = value;
  }
}
interface ModelOptions {
  material?: Material;
  configureMesh?: (mesh: AbstractMesh) => void;
  onReady?: (node: ModelNode) => void;
}
export class ModelAssets {
  private templates = new Map<string, Template[]>();
  private containers: AssetContainer[] = [];
  private pending = new Map<string, Set<() => void>>();
  private fallback: Mesh;
  private weaponTextures: WeaponTextures;
  readonly ready: Promise<void>;
  constructor(
    private scene: Scene,
    base: string,
    readonly status: Status = {},
    load: Loader = (kind) => LoadAssetContainerAsync(`${base}${kind}.glb`, scene),
  ) {
    this.weaponTextures = new WeaponTextures(scene, this.status);
    this.fallback = MeshBuilder.CreateBox('model-loading-template', { size: 1 }, scene);
    this.fallback.setEnabled(false);
    const material = new StandardMaterial('model-loading-metal', scene);
    material.diffuseColor = new Color3(0.12, 0.15, 0.17);
    this.fallback.material = material;
    this.ready = Promise.all(MODEL_NAMES.map((kind) => this.load(kind, load))).then(() => {});
    scene.onDisposeObservable.add(() => {
      for (const container of this.containers) container.dispose();
      this.templates.clear();
      this.pending.clear();
    });
  }
  private async load(kind: string, load: Loader) {
    this.status[`${kind}.glb`] = 'loading';
    let container: AssetContainer | undefined;
    try {
      container = await load(kind);
      if (this.scene.isDisposed) {
        container.dispose();
        return;
      }
      const templates: Template[] = [],
        materials = new Map<string, StandardMaterial>();
      for (const mesh of container.meshes) {
        if (!(mesh instanceof Mesh) || !mesh.getTotalVertices()) continue;
        const group = mesh.parent;
        mesh.computeWorldMatrix(true);
        const part = MODEL_DEFINITIONS[kind]!.parts?.includes(group?.name ?? '')
          ? group!.name
          : 'static';
        const origin =
          part === 'static'
            ? Vector3.Zero()
            : (group as TransformNode).getAbsolutePosition().clone();
        const pivot = Vector3.FromArray(
          (group?.metadata as Extras | null)?.gltf?.extras?.pivot ?? [0, 0, 0],
        );
        const standard = (mesh.material?.metadata as Extras | null)?.gltf?.extras?.standard;
        if (standard) {
          const name = mesh.material!.name;
          let material = materials.get(name);
          if (!material) {
            material = new StandardMaterial(name, this.scene);
            material.diffuseColor = Color3.FromArray(standard.diffuse);
            material.emissiveColor = Color3.FromArray(standard.emissive);
            material.specularColor = Color3.FromArray(standard.specular);
            materials.set(name, material);
            container.materials.push(material);
          }
          mesh.material = material;
        }
        // Normalize glTF handedness once; animation thereafter uses ordinary Babylon coordinates.
        mesh.bakeTransformIntoVertices(
          mesh
            .computeWorldMatrix(true)
            .multiply(Matrix.Translation(-origin.x, -origin.y, -origin.z)),
        );
        if (standard) {
          mesh.flipFaces();
          mesh.sideOrientation = 1;
        }
        this.weaponTextures.apply(kind, mesh);
        mesh.parent = null;
        mesh.position.setAll(0);
        mesh.rotation.setAll(0);
        mesh.rotationQuaternion = null;
        mesh.scaling.setAll(1);
        mesh.setEnabled(false);
        mesh.isPickable = false;
        templates.push({ mesh, part, origin, pivot });
      }
      if (!templates.length) throw new Error(`Empty model GLB: ${kind}`);
      this.containers.push(container);
      this.templates.set(kind, templates);
      this.status[`${kind}.glb`] = 'ready';
    } catch (error) {
      container?.dispose();
      this.status[`${kind}.glb`] = 'failed';
      console.warn(`Model unavailable, retaining primitive: ${kind}`, error);
    }
    // Consumer errors must not dispose a valid shared asset or prevent other owners attaching it.
    for (const apply of this.pending.get(kind) ?? []) {
      try {
        apply();
      } catch (error) {
        console.warn(`Model attachment failed: ${kind}`, error);
      }
    }
    this.pending.delete(kind);
  }
  create(kind: string, parent: TransformNode | null, options: ModelOptions = {}): ModelNode {
    const definition = MODEL_DEFINITIONS[kind];
    if (!definition) throw new Error(`Unknown model: ${kind}`);
    const root = new ModelNode(`model-${kind}`, this.scene);
    root.parent = parent;
    root.material = options.material;
    const anchor = new TransformNode(`${kind}-art`, this.scene);
    anchor.parent = root;
    if (definition.offset) anchor.position.copyFromFloats(...definition.offset);
    for (const part of definition.parts ?? []) {
      const node = new TransformNode(`${kind}-${part}`, this.scene);
      node.parent = anchor;
      root.parts.set(part, node);
      root.partMeshes.set(part, []);
    }
    // Clones still share geometry, but allow skin changes, UV remapping and fractional visibility.
    const clone = definition.clone || !!options.material;
    const fallback = clone
      ? this.fallback.clone(`${kind}-loading`, anchor)
      : this.fallback.createInstance(`${kind}-loading`);
    fallback.parent = anchor;
    fallback.scaling.copyFromFloats(...definition.fallbackSize);
    if (definition.fallbackOffset) fallback.position.copyFromFloats(...definition.fallbackOffset);
    fallback.setEnabled(true);
    fallback.isPickable = false;
    if (root.material) fallback.material = root.material;
    options.configureMesh?.(fallback);
    root.meshes = [fallback];
    const apply = () => {
      if (root.isDisposed()) return;
      const templates = this.templates.get(kind);
      if (!templates) return;
      const meshes: AbstractMesh[] = [];
      for (const { mesh, part, origin, pivot } of templates) {
        const owner = root.parts.get(part) ?? anchor;
        if (owner !== anchor) {
          owner.position.copyFrom(origin);
          owner.setPivotPoint(pivot);
        }
        const instance =
          clone || definition.cloneParts?.includes(part)
            ? mesh.clone(`${kind}-${part}-${mesh.name}`, owner)
            : mesh.createInstance(`${kind}-${part}-${mesh.name}`);
        instance.parent = owner;
        instance.setEnabled(true);
        instance.isPickable = false;
        if (root.material) instance.material = root.material;
        options.configureMesh?.(instance);
        meshes.push(instance);
        root.partMeshes.get(part)?.push(instance);
      }
      root.meshes = meshes;
      fallback.dispose();
      options.onReady?.(root);
    };
    if (this.templates.has(kind)) apply();
    else if (this.status[`${kind}.glb`] !== 'failed') {
      const listeners = this.pending.get(kind) ?? new Set<() => void>();
      listeners.add(apply);
      this.pending.set(kind, listeners);
      root.onDisposeObservable.addOnce(() => listeners.delete(apply));
    }
    return root;
  }
}
