/// <reference types="vite/client" />
import { contentURL, currentContent } from '../../content/runtime';
// Presentation-only asset adapter. Model data never defines simulation geometry.
import { ModelAssets } from './model-assets';
import type { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { wallSurface } from '../environment/wall-surface';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import type { Appearance } from '../../player/appearance';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Wall } from '../../core/geometry';
import { themeByID, skinByID } from '../../content/types';
import type { Catalog } from '../../content/types';
import type { MapTheme } from '../../maps/types';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';

type AssetState = 'loading' | 'ready' | 'failed';
const BASE = `${import.meta.env.BASE_URL}assets/kit/`;

export class VisualKit {
  readonly status: Record<string, AssetState> = {};
  readonly models: ModelAssets;
  private floorMaterial?: StandardMaterial;
  private earthMaterial?: StandardMaterial;
  get terrain(): StandardMaterial {
    return (this.floorMaterial ??= this.surface(
      'terrain',
      themeByID(this.content, this.theme).floor,
    ));
  }
  get earth(): StandardMaterial {
    if (!this.earthMaterial) {
      const theme = themeByID(this.content, this.theme);
      this.earthMaterial = theme.outdoorWear
        ? this.surface('earth', theme.earth!)
        : new StandardMaterial('unused-earth', this.scene);
      this.earthMaterial.diffuseColor = Color3.FromHexString('#c7b796');
      this.earthMaterial.specularColor = Color3.Black();
      this.earthMaterial.alpha = 0.99;
    }
    return this.earthMaterial;
  }
  get masonry(): StandardMaterial {
    return this.wallMaterials.subMaterials[0] as StandardMaterial;
  }
  get coping(): StandardMaterial {
    return this.wallMaterials.subMaterials[1] as StandardMaterial;
  }
  get wallMaterials(): MultiMaterial {
    const theme = themeByID(this.content, this.theme);
    return this.materialsFor(theme.defaultMaterial);
  }
  readonly flash: StandardMaterial;
  contentFailure = false;
  private failures = new Map<string, Set<() => void>>();
  private textures = new Map<string, Texture>();
  private wallSets = new Map<string, MultiMaterial>();
  private masks = new Map<string, Promise<Uint8ClampedArray>>();
  private skinValues = new WeakMap<StandardMaterial, Appearance>();
  private skinRequests = new WeakMap<StandardMaterial, string>();

  constructor(
    private scene: Scene,
    private castShadow: (mesh: AbstractMesh) => void,
    readonly theme: MapTheme = 'classic',
    readonly content: Catalog = currentContent(),
  ) {
    this.flash = this.surface('muzzle', 'muzzle-flash.png');
    this.flash.disableLighting = true;
    this.flash.diffuseColor = Color3.Black();
    this.flash.specularColor = Color3.Black();
    // StandardMaterial adds its emissive color to the texture; black avoids a solid quad.
    this.flash.emissiveColor = Color3.Black();
    this.flash.emissiveTexture = this.flash.diffuseTexture;
    this.flash.diffuseTexture = null;
    this.flash.alphaMode = Constants.ALPHA_ADD;
    this.flash.alpha = 0.99;
    this.flash.backFaceCulling = false;
    this.flash.disableDepthWrite = true;
    this.models = new ModelAssets(scene, `${BASE}models/`, this.status);
  }

  private texture(file: string, unavailable: () => void): Texture {
    const url = file.startsWith('/content/')
      ? contentURL(file)
      : file.startsWith('blob:')
        ? file
        : `${BASE}textures/${file}`;
    const listeners = this.failures.get(url) ?? new Set<() => void>();
    listeners.add(unavailable);
    this.failures.set(url, listeners);
    const cached = this.textures.get(url);
    if (cached) {
      if (this.status[file] === 'failed') queueMicrotask(unavailable);
      return cached;
    }
    this.status[file] = 'loading';
    const texture = new Texture(
      url,
      this.scene,
      false,
      true,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => {
        this.status[file] = 'ready';
      },
      (message) => {
        this.status[file] = 'failed';
        if (file.startsWith('/content/')) this.contentFailure = true;
        for (const fail of listeners) fail();
        console.warn(`Visual kit texture unavailable: ${file}`, message);
      },
    );
    texture.anisotropicFilteringLevel = 4;
    this.textures.set(url, texture);
    return texture;
  }

  private surface(name: string, file: string): StandardMaterial {
    const material = new StandardMaterial(`kit-${name}`, this.scene);
    material.diffuseTexture = this.texture(file, () => {
      material.diffuseTexture = null;
      material.emissiveTexture = null;
      material.diffuseColor = new Color3(0.6, 0.65, 0.55);
      if (name === 'muzzle') material.alpha = 0;
    });
    material.specularColor = new Color3(0.08, 0.08, 0.08);
    material.specularPower = 24;
    return material;
  }

  skin(name: string): StandardMaterial {
    const material = new StandardMaterial(`skin-${name}`, this.scene);
    material.specularColor = new Color3(0.08, 0.08, 0.08);
    material.specularPower = 24;
    return material;
  }

  private async loadMask(name: string): Promise<Uint8ClampedArray> {
    const file = skinByID(this.content, name).mask;
    this.status[file] = 'loading';
    try {
      const response = await fetch(contentURL(file), { credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      try {
        if (bitmap.width !== 512 || bitmap.height !== 256)
          throw new Error('Invalid skin dimensions');
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 256;
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, 512, 256).data;
        this.status[file] = 'ready';
        return pixels;
      } finally {
        bitmap.close();
      }
    } catch (error) {
      this.status[file] = 'failed';
      this.contentFailure = true;
      console.warn(`Skin template unavailable: ${file}`, error);
      // Primary-color fallback, including when the mask request fails before a skin exists.
      return new Uint8ClampedArray();
    }
  }

  setSkin(material: StandardMaterial, appearance: Appearance): void {
    if (this.skinValues.get(material) === appearance) return;
    this.skinValues.set(material, appearance);
    const key = `${appearance.template}:${appearance.colors.join(':')}`;
    if (this.skinRequests.get(material) === key) return;
    this.skinRequests.set(material, key);
    material.diffuseColor = Color3.FromHexString(appearance.colors[0]);
    const colors = appearance.colors.map((c) =>
      [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)),
    );
    // Load only selected templates; expanding the catalog must not grow scene startup work.
    const maskURL = contentURL(skinByID(this.content, appearance.template).mask);
    let pending = this.masks.get(maskURL);
    if (!pending) {
      pending = this.loadMask(appearance.template);
      this.masks.set(maskURL, pending);
    }
    void pending.then((mask) => {
      if (
        this.scene.isDisposed ||
        !this.scene.materials.includes(material) ||
        this.skinRequests.get(material) !== key
      )
        return;
      material.diffuseTexture?.dispose();
      material.diffuseTexture = null;
      if (!mask.length) return;
      const pixels = new Uint8Array(512 * 256 * 3);
      for (let i = 0, j = 0; i < mask.length; i += 4, j += 3) {
        const total = mask[i]! + mask[i + 1]! + mask[i + 2]! || 1;
        for (let c = 0; c < 3; c++)
          pixels[j + c] = Math.round(
            (mask[i]! * colors[0]![c]! +
              mask[i + 1]! * colors[1]![c]! +
              mask[i + 2]! * colors[2]![c]!) /
              total,
          );
      }
      material.diffuseColor = Color3.White();
      material.diffuseTexture = RawTexture.CreateRGBTexture(
        pixels,
        512,
        256,
        this.scene,
        true,
        true,
        Texture.TRILINEAR_SAMPLINGMODE,
      );
    });
  }

  private materialsFor(materialID: string): MultiMaterial {
    const definition = themeByID(this.content, this.theme).materials[materialID];
    if (!definition) throw new Error(`Unknown wall material: ${materialID}`);
    let materials = this.wallSets.get(materialID);
    if (!materials) {
      materials = new MultiMaterial(`wall-${materialID}`, this.scene);
      materials.subMaterials = [
        this.surface(`${materialID}-wall`, definition.wall),
        this.surface(`${materialID}-top`, definition.top),
      ];
      for (const value of materials.subMaterials) {
        const surface = value as StandardMaterial;
        if (definition.emission > 0) {
          surface.emissiveTexture = surface.diffuseTexture;
          surface.emissiveColor = new Color3(
            definition.emission,
            definition.emission,
            definition.emission,
          );
        }
      }
      this.wallSets.set(materialID, materials);
    }
    return materials;
  }

  wall(wall: Wall & { material?: string }, id: number): TransformNode {
    const height = wall.height ?? 0.7;
    const root = new TransformNode(`wall-${id}`, this.scene);
    root.position.set(wall.x + wall.w / 2, height / 2, wall.y + wall.h / 2);
    root.scaling.set(wall.w, height, wall.h);
    root.freezeWorldMatrix();
    const scenario = themeByID(this.content, this.theme);
    const materialID = wall.material ?? scenario.defaultMaterial;
    const definition = scenario.materials[materialID];
    if (!definition) throw new Error(`Unknown wall material: ${materialID}`);
    const materials = this.materialsFor(materialID);
    const selected = materials;
    this.models.create('wall', root, {
      material: materials.subMaterials[0]!,
      configureMesh: (mesh) => {
        if (mesh instanceof Mesh) {
          wallSurface(mesh, wall, selected, definition.tile);
          mesh.receiveShadows = true;
          this.castShadow(mesh);
          mesh.freezeWorldMatrix();
        }
      },
    });
    return root;
  }
}
