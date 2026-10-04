import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';

export function photonMaterial(scene: Scene): ShaderMaterial {
  const material = new ShaderMaterial(
    'photon-neon',
    scene,
    {
      vertexSource: `precision highp float;
      attribute vec3 position; attribute vec2 uv;
      uniform mat4 worldViewProjection; varying vec2 vUV;
      void main(){vUV=uv;gl_Position=worldViewProjection*vec4(position,1.0);}`,
      fragmentSource: `precision highp float;
      varying vec2 vUV; uniform float opacity;
      void main(){
        float radius=abs(vUV.x*2.0-1.0);
        float core=exp(-pow(radius/0.19,2.0));
        float glow=exp(-pow(radius/0.52,2.0));
        float edge=1.0-smoothstep(0.72,1.0,radius);
        float ends=smoothstep(0.0,0.015,vUV.y)*smoothstep(0.0,0.015,1.0-vUV.y);
        vec3 color=mix(vec3(0.12,0.55,1.0),vec3(0.88,0.98,1.0),core);
        gl_FragColor=vec4(color,(core+0.55*glow)*edge*ends*opacity);
      }`,
    },
    {
      attributes: ['position', 'uv'],
      uniforms: ['worldViewProjection', 'opacity'],
      needAlphaBlending: true,
    },
  );
  // Add light over the arena while retaining depth occlusion by walls and actors.
  material.alphaMode = Constants.ALPHA_ADD;
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.onBindObservable.add((mesh) =>
    material.getEffect()?.setFloat('opacity', mesh?.visibility ?? 1),
  );
  return material;
}
