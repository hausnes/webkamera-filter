/* Shell-textured fur: the base geometry is repeated in N layers pushed out along
 * the normals, and each layer discards fragments outside thin "strands" laid out
 * on a jittered grid in UV space. With depth testing this reads as real fluff. */

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  attribute float shell;
  uniform float furLength;
  uniform vec3 gravityDir; // object space
  uniform float droop;     // how much the strands hang with gravity
  varying vec2 vUv;
  varying float vShell;
  varying vec3 vNormalView;

  void main() {
    vUv = uv;
    vShell = shell;
    // Strands lean with gravity towards their tips.
    vec3 p = position + normal * shell * furLength + gravityDir * furLength * droop * shell * shell;
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec2 uvScale;
  uniform vec3 baseColor;
  uniform vec3 lightDir;   // view space, towards the light
  uniform vec3 lightColor;
  uniform vec3 ambientColor;
  uniform float curl;      // strands wind around as they grow out
  uniform float edgeWidth; // in UV units; > 0 thins the fur out towards the UV borders
  varying vec2 vUv;
  varying float vShell;
  varying vec3 vNormalView;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    vec2 g = vUv * uvScale;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash(id);
    vec2 jitter = (vec2(hash(id + 17.0), hash(id + 31.0)) - 0.5) * 0.4;
    float angle = (vShell * curl + h) * 6.2832;
    jitter += vec2(cos(angle), sin(angle)) * 0.2 * min(curl, 1.0);
    float strandLength = 0.55 + 0.45 * h;

    if (edgeWidth > 0.0) {
      // Sparse, shorter strands near the border instead of a hard edge.
      vec2 e = min(vUv, 1.0 - vUv);
      float edge = smoothstep(0.0, edgeWidth, min(e.x, e.y));
      if (h > edge * 1.4) discard;
      strandLength *= mix(0.4, 1.0, edge);
    }

    if (vShell > 0.0) {
      if (vShell > strandLength) discard;
      // Thick roots, gently tapering tips: soft plush rather than spikes.
      float radius = 0.62 * (1.0 - 0.75 * vShell / strandLength);
      if (length(f - jitter) > radius) discard;
    }

    vec3 n = normalize(vNormalView);
    // Wrapped diffuse: light scatters through fur, so the terminator is soft.
    float diffuse = max(dot(n, normalize(lightDir)) * 0.6 + 0.4, 0.0);
    // Self-shadowing: deep inside the fur is darker, the tips catch the light.
    float occlusion = mix(0.62, 1.0, smoothstep(0.0, 0.7, vShell));
    float variation = 0.92 + 0.08 * h;
    vec3 color = baseColor * variation * occlusion * (ambientColor + lightColor * diffuse);
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Builds one geometry containing `shells` stacked copies of `base`. */
export function createFurGeometry(base, shells) {
  const pos = base.attributes.position;
  const nrm = base.attributes.normal;
  const uv = base.attributes.uv;
  const idx = base.index.array;
  const n = pos.count;

  const positions = new Float32Array(n * shells * 3);
  const normals = new Float32Array(n * shells * 3);
  const uvs = new Float32Array(n * shells * 2);
  const shellAttr = new Float32Array(n * shells);
  const indices = new Uint32Array(idx.length * shells);

  for (let s = 0; s < shells; s++) {
    positions.set(pos.array, s * n * 3);
    normals.set(nrm.array, s * n * 3);
    uvs.set(uv.array, s * n * 2);
    shellAttr.fill(s / (shells - 1), s * n, (s + 1) * n);
    for (let i = 0; i < idx.length; i++) indices[s * idx.length + i] = idx[i] + s * n;
  }

  const geo = new THREE.BufferGeometry();
  geo.userData.shells = shells;
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('shell', new THREE.BufferAttribute(shellAttr, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

/** Copies a deformed base geometry into every shell of a fur geometry. */
export function updateFurGeometry(furGeo, base) {
  const pos = base.attributes.position.array;
  const nrm = base.attributes.normal.array;
  const furPos = furGeo.attributes.position;
  const furNrm = furGeo.attributes.normal;
  for (let s = 0; s < furGeo.userData.shells; s++) {
    furPos.array.set(pos, s * pos.length);
    furNrm.array.set(nrm, s * nrm.length);
  }
  furPos.needsUpdate = true;
  furNrm.needsUpdate = true;
  furGeo.computeBoundingSphere();
}

export function createFurMaterial({ furLength, uvScale, color = 0xf6f3ec, droop = 0.35, curl = 0, edgeWidth = 0 }) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      furLength: { value: furLength },
      uvScale: { value: uvScale.clone() },
      gravityDir: { value: new THREE.Vector3(0, -1, 0) },
      droop: { value: droop },
      curl: { value: curl },
      edgeWidth: { value: edgeWidth },
      baseColor: { value: new THREE.Color(color) },
      lightDir: { value: new THREE.Vector3(0.3, 0.8, 0.5) },
      lightColor: { value: new THREE.Color(1, 1, 1) },
      ambientColor: { value: new THREE.Color(0.35, 0.37, 0.42) }
    }
  });
}

/** Light direction (view space, towards the light) and colours for fur materials. */
export function setFurLighting(materials, lightDir, lightColor, ambientColor) {
  for (const m of materials) {
    m.uniforms.lightDir.value.copy(lightDir);
    m.uniforms.lightColor.value.copy(lightColor);
    m.uniforms.ambientColor.value.copy(ambientColor);
  }
}
