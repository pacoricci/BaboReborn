// Analytic flame wisps: no particle allocation, bitmap download or gameplay randomness.
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
// Advect turbulence in world units so shortening the jet does not speed it up.
const jetFragment = `precision highp float;
  varying vec2 vUV; varying float vAlong;
  uniform float time; uniform float opacity;
  float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float noise(vec2 p){
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),
      mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0)),f.x),f.y);
  }
  void main(){
    float along=vUV.y, x=vUV.x*2.0-1.0;
    vec2 flow=vec2(x*3.2,vAlong*2.3-time*11.0);
    float billow=noise(flow);
    float detail=noise(flow*2.1+vec2(7.3,time*1.3));
    float turbulence=billow*0.7+detail*0.3;
    float spread=0.12+0.72*smoothstep(0.0,0.65,along);
    float bend=(noise(vec2(vAlong*1.8-time*8.0,4.7))-0.5)*along*0.28;
    float radius=abs(x-bend)/spread;
    float body=1.0-smoothstep(0.3,1.0,radius+(turbulence-0.5)*0.85);
    float tip=1.0-smoothstep(0.68,1.0,along+(turbulence-0.5)*0.23);
    float ends=smoothstep(0.0,0.025,along)*(1.0-smoothstep(0.94,1.0,along));
    float heat=clamp((1.0-radius)*0.65+(turbulence-0.45)*1.25+(1.0-along)*0.25,0.0,1.0);
    vec3 color=mix(vec3(0.85,0.08,0.008),vec3(1.0,0.42,0.035),smoothstep(0.1,0.55,heat));
    color=mix(color,vec3(1.0,0.9,0.5),smoothstep(0.55,0.95,heat));
    float wisps=smoothstep(0.18,0.62,turbulence+(1.0-along)*0.25);
    gl_FragColor=vec4(color,body*tip*ends*(0.25+0.65*wisps)*opacity);
  }`;

// Analytic, staggered wisps break up the silhouette instead of outlining a fixed mesh.
const poolVertex = `precision highp float;
  attribute vec3 position; attribute vec2 uv; attribute vec2 uv2;
  uniform mat4 world; uniform mat4 worldViewProjection; uniform float time;
  varying vec2 vUV; varying float vAge; varying float vSeed;
  void main(){
    float seed=uv2.x;
    vSeed=seed*2.31+dot(world[0].xz,vec2(2.31,5.17));
    vAge=fract(time*(0.85+fract(seed*0.37)*0.35)+seed*0.618);
    vUV=uv;
    float angle=seed*2.4;
    float radius=0.04+0.19*sqrt(fract(seed*0.73));
    vec2 center=vec2(sin(angle),cos(angle))*radius;
    center+=vec2(sin(vAge*4.0+seed),cos(vAge*3.0+seed))*vAge*0.055;
    float size=(0.2+fract(seed*0.43)*0.12)*(1.0-vAge*0.4);
    vec2 corner=(uv*2.0-1.0)*size;
    vec3 p=vec3(center.x+corner.x,0.025+vAge*0.7+corner.y*0.45,center.y+corner.y);
    gl_Position=worldViewProjection*vec4(p,1.0);
  }`;
const poolFragment = `precision highp float;
  varying vec2 vUV; varying float vAge; varying float vSeed;
  uniform float time; uniform float opacity;
  float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float noise(vec2 p){
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),
      mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0)),f.x),f.y);
  }
  void main(){
    vec2 p=vUV*2.0-1.0;
    vec2 flow=p*3.0+vec2(vSeed,-time*3.5);
    float n=noise(flow)*0.65+noise(flow*2.1+7.3)*0.35;
    float radius=length(p*vec2(1.25,0.8));
    float shape=1.0-smoothstep(0.2,0.8,radius+(n-0.5)*0.85);
    float life=smoothstep(0.0,0.12,vAge)*(1.0-smoothstep(0.8,1.0,vAge));
    float heat=clamp((1.0-radius)*0.55+n*0.5-vAge*0.08,0.0,1.0);
    vec3 color=mix(vec3(0.9,0.085,0.008),vec3(1.0,0.42,0.025),smoothstep(0.15,0.65,heat));
    color=mix(color,vec3(1.0,0.82,0.3),smoothstep(0.65,1.0,heat));
    gl_FragColor=vec4(color,shape*life*(0.35+0.3*n)*opacity);
  }`;

export function fireMaterial(scene: Scene, beam = false): ShaderMaterial {
  const material = new ShaderMaterial(
    'fire-wisps',
    scene,
    {
      vertexSource: beam
        ? `precision highp float;
      attribute vec3 position; attribute vec2 uv;
      uniform mat4 worldViewProjection; varying vec2 vUV; varying float vAlong;
      void main(){vUV=uv;vAlong=position.z;gl_Position=worldViewProjection*vec4(position,1.0);}`
        : poolVertex,
      fragmentSource: beam ? jetFragment : poolFragment,
    },
    {
      attributes: beam ? ['position', 'uv'] : ['position', 'uv', 'uv2'],
      uniforms: ['world', 'worldViewProjection', 'time', 'opacity'],
      needAlphaBlending: true,
    },
  );
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.alphaMode = Constants.ALPHA_ADD;
  material.onBindObservable.add((mesh) =>
    material.getEffect()?.setFloat('opacity', mesh?.visibility ?? 1),
  );
  let time = 0;
  scene.onBeforeRenderObservable.add(() => {
    time += Math.min(scene.getEngine().getDeltaTime() / 1000, 0.1);
    material.setFloat('time', time);
  });
  return material;
}
