import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { ArenaMap } from '../../maps/types';
import type { Catalog } from '../../content/types';
import { decalByID } from '../../content/types';
import { contentURL } from '../../content/runtime';
import { FLOOR_LAYERS } from './floor-layers';

type AssetState = 'loading' | 'ready' | 'failed';
export class FloorDecals {
  readonly meshes: readonly Mesh[];
  private materials = new Map<string, StandardMaterial>();
  constructor(scene: Scene, arena: ArenaMap, content: Catalog, status: Record<string, AssetState>) {
    this.meshes = (arena.decals ?? []).map((decal, index) => {
      let material = this.materials.get(decal.asset);
      if (!material) {
        const asset = decalByID(content, decal.asset);
        const surface = new StandardMaterial(`decal-${asset.id}`, scene);
        material = surface;
        status[asset.texture] = 'loading';
        const texture = new Texture(
          contentURL(asset.texture),
          scene,
          false,
          true,
          Texture.TRILINEAR_SAMPLINGMODE,
          () => {
            status[asset.texture] = 'ready';
          },
          () => {
            status[asset.texture] = 'failed';
            // Optional art must disappear cleanly if its immutable texture is unavailable.
            surface.alpha = 0;
          },
        );
        texture.hasAlpha = true;
        texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
        texture.anisotropicFilteringLevel = 4;
        surface.diffuseTexture = texture;
        surface.useAlphaFromDiffuseTexture = true;
        surface.specularColor = Color3.Black();
        surface.disableDepthWrite = true;
        this.materials.set(asset.id, surface);
      }
      const mesh = MeshBuilder.CreateGround(
        `floor-decal-${index}`,
        { width: decal.w, height: decal.h },
        scene,
      );
      mesh.material = material;
      mesh.visibility = decal.opacity;
      mesh.position.set(decal.x, FLOOR_LAYERS.decalHeightCells, decal.y);
      mesh.rotation.y = decal.angle;
      mesh.alphaIndex = FLOOR_LAYERS.decalStart + index;
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      mesh.freezeWorldMatrix();
      return mesh;
    });
  }
  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    for (const material of this.materials.values()) material.dispose(false, true);
    this.materials.clear();
  }
}
