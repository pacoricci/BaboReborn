// Scene-owned cosmetic surfaces shared by held, dropped and deployed equipment.
import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { PRIMARY_MODELS } from '../actors/arsenal';

const EQUIPMENT = new Set([
  ...PRIMARY_MODELS,
  'knives',
  'grenade',
  'molotov',
  'rocket',
  'minibot',
  'weapon-mount',
  'health',
]);
const SURFACES = {
  coating: { scale: 2, specular: 0.12, power: 24, roughness: 0.72 },
  steel: { scale: 2.5, specular: 0.36, power: 72, roughness: 0.38 },
  scorched: { scale: 2, specular: 0.16, power: 32, roughness: 0.68 },
  grip: { scale: 4, specular: 0.035, power: 12, roughness: 0.92 },
  cloth: { scale: 5, specular: 0.015, power: 8, roughness: 0.98 },
  paper: { scale: 3, specular: 0.025, power: 8, roughness: 0.95 },
};
type Surface = keyof typeof SURFACES;
type Status = Record<string, 'loading' | 'ready' | 'failed'>;

function surfaceFor(kind: string, name: string): Surface {
  if (name === 'bottle-wick') return 'cloth';
  if (/bottle-(label|ink)/.test(name)) return 'paper';
  if (kind === 'molotov' && /carbon/.test(name)) return 'scorched';
  if (name === 'world-carbon' || (kind === 'grenade' && /carbon/.test(name)))
    return kind === 'rocket' ? 'scorched' : 'coating';
  if (/carbon|rubber/.test(name)) return 'grip';
  if (/steel|metal|blade|brass|bottle-(green|rim)/.test(name))
    return ['flamethrower', 'chain', 'rocket'].includes(kind) ? 'scorched' : 'steel';
  return 'coating';
}

export class WeaponTextures {
  private textures = new Map<Surface, Texture>();
  private materials = new Map<Surface, Set<StandardMaterial | PBRMaterial>>();
  constructor(
    private scene: Scene,
    private status: Status = {},
  ) {}

  private texture(surface: Surface): Texture {
    const cached = this.textures.get(surface);
    if (cached) return cached;
    const file = `equipment/${surface}.webp`;
    this.status[file] = 'loading';
    const texture = new Texture(
      `/assets/kit/textures/${file}`,
      this.scene,
      false,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => {
        this.status[file] = 'ready';
      },
      (_message, error) => {
        this.status[file] = 'failed';
        // A failed cosmetic download must not leave equipment waiting on an unready texture.
        // Imported PBR materials may still belong to an AssetContainer, not scene.materials.
        for (const material of this.materials.get(surface) ?? []) {
          if (material instanceof StandardMaterial) {
            if (material.diffuseTexture === texture) material.diffuseTexture = null;
            if (material.specularTexture === texture) material.specularTexture = null;
          } else if (material instanceof PBRMaterial && material.albedoTexture === texture)
            material.albedoTexture = null;
        }
        console.warn(`Equipment texture unavailable: ${file}`, error);
      },
    );
    texture.name = `equipment-${surface}`;
    texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = 4;
    this.textures.set(surface, texture);
    return texture;
  }

  apply(kind: string, mesh: Mesh): void {
    if (!EQUIPMENT.has(kind)) return;
    const material = mesh.material;
    if (!(material instanceof StandardMaterial || material instanceof PBRMaterial)) return;
    if (/recess|light/.test(material.name)) return;
    const surface = surfaceFor(kind, material.name);
    if (this.status[`equipment/${surface}.webp`] === 'failed') return;
    const finish = SURFACES[surface];
    const glass = /bottle-(green|rim)/.test(material.name);
    if (!glass) {
      // Baked local coordinates keep wear attached during recoil/rotation and shared by
      // instances. Dominant-normal projection also covers the bevels' collapsed authoring UVs.
      const positions = mesh.getVerticesData('position')!;
      const normals = mesh.getVerticesData('normal')!;
      const uv: number[] = [];
      for (let i = 0; i < positions.length; i += 3) {
        const nx = Math.abs(normals[i]!),
          ny = Math.abs(normals[i + 1]!),
          nz = Math.abs(normals[i + 2]!);
        const a = nx > ny && nx > nz ? 2 : 0;
        const b = ny >= nx && ny >= nz ? 2 : 1;
        uv.push(positions[i + a]! * finish.scale, positions[i + b]! * finish.scale);
      }
      mesh.setVerticesData('uv', uv);
    }
    const texture = this.texture(surface);
    if (this.status[`equipment/${surface}.webp`] === 'failed') return;
    const materials = this.materials.get(surface) ?? new Set<StandardMaterial | PBRMaterial>();
    materials.add(material);
    this.materials.set(surface, materials);
    if (material instanceof StandardMaterial) {
      // Glass stays opaque: scuffs interrupt its gloss without looking like painted metal.
      if (!glass) material.diffuseTexture = texture;
      material.specularTexture = texture;
      material.specularColor = Color3.White().scale(glass ? 0.5 : finish.specular);
      material.specularPower = glass ? 96 : finish.power;
    } else {
      material.albedoTexture = texture;
      material.roughness = finish.roughness;
    }
  }
}
