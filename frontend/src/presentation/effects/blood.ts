import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { Vec2 } from '../../core/geometry';

interface Drop {
  mesh: Mesh;
  x: number;
  z: number;
  vx: number;
  vz: number;
  vy: number;
}
interface Burst {
  stain: Mesh;
  drops: Drop[];
  age: number;
}

// Scene-local and bounded: cosmetic randomness never enters simulation or prediction.
export class BloodEffects {
  private bursts: Burst[] = [];
  private spray: StandardMaterial;
  private stain: ShaderMaterial;
  private seeds = new WeakMap<AbstractMesh, number>();

  constructor(private scene: Scene) {
    this.spray = new StandardMaterial('blood-drops', scene);
    this.spray.diffuseColor = Color3.FromHexString('#65070b');
    this.spray.emissiveColor = Color3.FromHexString('#100101');
    this.spray.specularColor = Color3.FromHexString('#241516');
    this.stain = new ShaderMaterial(
      'blood-stain',
      scene,
      {
        vertexSource: `precision highp float;
        attribute vec3 position; attribute vec2 uv;
        uniform mat4 worldViewProjection; varying vec2 vUV;
        void main(){ vUV=uv; gl_Position=worldViewProjection*vec4(position,1.0); }`,
        fragmentSource: `precision highp float;
        varying vec2 vUV; uniform float opacity; uniform float seed;
        float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7))+seed)*43758.5453);}
        float noise(vec2 p){
          vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),
                     mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0)),f.x),f.y);
        }
        void main(){
          vec2 p=vUV*2.0-1.0;
          float rough=noise(p*19.0)*0.065+noise(p*51.0)*0.025;
          float mask=0.0;
          // Overlapping off-centre pools, with no radial repetition or star silhouette.
          for(int i=0;i<7;i++){
            float f=float(i);
            vec2 center=vec2(hash(vec2(f,1.0))-.5,hash(vec2(f,2.0))-.5)*.53;
            vec2 stretch=vec2(.75+hash(vec2(f,3.0)),.75+hash(vec2(f,4.0)));
            float radius=.12+hash(vec2(f,5.0))*.17;
            float d=length((p-center)*stretch)+rough;
            mask=max(mask,1.0-smoothstep(radius-.018,radius,d));
          }
          // Uneven trails and satellite droplets follow one broad splash direction.
          for(int i=0;i<24;i++){
            float f=float(i);
            float angle=(hash(vec2(f,6.0))-.5)*4.5;
            vec2 axis=vec2(cos(angle),sin(angle));
            float distance=.22+hash(vec2(f,7.0))*.58;
            vec2 q=p-axis*distance;
            vec2 local=vec2(dot(q,axis),dot(q,vec2(-axis.y,axis.x)));
            float width=.008+pow(hash(vec2(f,8.0)),2.0)*.04;
            local.x/=(1.0+hash(vec2(f,9.0))*3.5);
            float d=length(local)+rough*.16;
            mask=max(mask,1.0-smoothstep(width*.7,width,d));
          }
          float grain=noise(p*95.0);
          float thickness=noise(p*8.0)*.65+noise(p*27.0)*.35;
          vec3 color=mix(vec3(.095,.009,.008),vec3(.29,.018,.015),thickness);
          // Broken, soaked edges retain some floor texture; pooled centres stay dark.
          float soaked=mix(.58,.96,smoothstep(.1,.8,thickness));
          float edge=1.0-smoothstep(.88,.99,max(abs(p.x),abs(p.y)));
          gl_FragColor=vec4(color,mask*edge*opacity*soaked*(.88+.12*grain));
        }`,
      },
      {
        attributes: ['position', 'uv'],
        uniforms: ['worldViewProjection', 'opacity', 'seed'],
        needAlphaBlending: true,
      },
    );
    this.stain.disableDepthWrite = true;
    this.stain.onBindObservable.add((mesh) => {
      const effect = this.stain.getEffect();
      effect?.setFloat('opacity', mesh?.visibility ?? 1);
      effect?.setFloat('seed', mesh ? (this.seeds.get(mesh) ?? 0) : 0);
    });
  }

  hit(position: Vec2, damage: number): void {
    if (!(damage > 0)) return;
    if (this.bursts.length >= 24) this.dispose(this.bursts.shift()!);
    const strength = Math.min(1, damage / 60);
    const size = (2.2 + strength * 2.0) * (0.85 + Math.random() * 0.35);
    const stain = MeshBuilder.CreateGround(
      'blood-stain',
      { width: size, height: size },
      this.scene,
    );
    this.seeds.set(stain, Math.random() * 1000);
    stain.scaling.z = 0.75 + Math.random() * 0.6;
    stain.material = this.stain;
    stain.isPickable = false;
    stain.position.set(position.x, 0.012 + Math.random() * 0.006, position.y);
    stain.rotation.y = Math.random() * Math.PI * 2;
    stain.visibility = 0;
    const drops: Drop[] = [];
    for (let i = 0; i < 6 + Math.floor(strength * 4); i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.2 + Math.random() * (1.8 + strength);
      const mesh = MeshBuilder.CreateSphere(
        'blood-drop',
        { diameter: 0.018 + Math.random() * 0.045, segments: 4 },
        this.scene,
      );
      mesh.material = this.spray;
      mesh.isPickable = false;
      mesh.scaling.set(0.7, 1.5 + Math.random() * 1.8, 0.7);
      mesh.position.set(position.x, 0.3, position.y);
      drops.push({
        mesh,
        x: position.x,
        z: position.y,
        vx: Math.cos(angle) * speed,
        vz: Math.sin(angle) * speed,
        vy: 0.7 + Math.random() * 1.6,
      });
    }
    this.bursts.push({ stain, drops, age: 0 });
  }

  render(dt: number): void {
    this.bursts = this.bursts.filter((burst) => {
      burst.age += Math.max(0, dt);
      const t = burst.age;
      if (t >= 9) {
        this.dispose(burst);
        return false;
      }
      burst.stain.visibility = Math.min(1, t / 0.18) * Math.min(1, (9 - t) / 3);
      burst.drops = burst.drops.filter((drop) => {
        const height = 0.3 + drop.vy * t - 4.9 * t * t;
        if (height <= 0.02) {
          drop.mesh.dispose();
          return false;
        }
        drop.mesh.position.set(drop.x + drop.vx * t, height, drop.z + drop.vz * t);
        drop.mesh.rotation.z = -Math.atan2(drop.vx, drop.vy - 9.8 * t);
        return true;
      });
      return true;
    });
  }

  reset(): void {
    for (const burst of this.bursts) this.dispose(burst);
    this.bursts = [];
  }

  private dispose(burst: Burst): void {
    burst.stain.dispose();
    for (const drop of burst.drops) drop.mesh.dispose();
  }
}
