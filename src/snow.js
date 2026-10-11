/* Falling snow as a point cloud inside the camera frustum (camera space, cm).
 * Flakes closer than the focus distance are drawn larger and blurrier, which
 * fakes depth of field and sells the 3D effect. */

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  attribute float size;
  uniform float pixelsPerUnit; // screen pixels per cm at 1 cm depth
  uniform float focusDepth;
  varying float vBlur;
  varying float vAlpha;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float depth = -mv.z;
    // Defocus grows with distance from the focal plane (the person).
    vBlur = clamp(abs(depth - focusDepth) / focusDepth, 0.0, 1.0);
    float px = size * pixelsPerUnit / depth;
    float blurPx = px * (1.0 + vBlur * 1.5);
    gl_PointSize = clamp(blurPx, 1.5, 90.0);
    // Keep the total light of a blurred flake roughly constant.
    vAlpha = clamp((px * px) / (blurPx * blurPx), 0.15, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float opacity;
  varying float vBlur;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float edge = mix(0.15, 0.95, vBlur);
    float a = 1.0 - smoothstep(1.0 - edge, 1.0, d);
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vec3(1.0), a * vAlpha * opacity);
  }
`;

export class Snow {
  /**
   * @param {object} opts
   * @param {number} opts.count number of flakes
   * @param {[number, number]} opts.depth near/far depth range in cm
   * @param {[number, number]} opts.size flake diameter range in cm
   */
  constructor({ count, depth, size, opacity = 0.9, focusDepth = 55 }) {
    this.count = count;
    this.depth = depth;
    this.time = 0;
    this.tanHalfFov = Math.tan(THREE.MathUtils.degToRad(30));
    this.aspect = 16 / 9;

    this.positions = new Float32Array(count * 3);
    this.speed = new Float32Array(count);
    this.phase = new Float32Array(count);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      sizes[i] = THREE.MathUtils.randFloat(size[0], size[1]);
      this.respawn(i, true);
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        pixelsPerUnit: { value: 600 },
        focusDepth: { value: focusDepth },
        opacity: { value: opacity }
      },
      transparent: true,
      depthWrite: false
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  /** Call when the camera or viewport changes. */
  setView(camera, viewportHeight) {
    this.tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    this.aspect = camera.aspect;
    this.material.uniforms.pixelsPerUnit.value = viewportHeight / (2 * this.tanHalfFov);
  }

  respawn(i, anywhere) {
    const z = THREE.MathUtils.randFloat(this.depth[0], this.depth[1]);
    const halfH = z * this.tanHalfFov;
    const halfW = halfH * this.aspect;
    this.positions[i * 3] = THREE.MathUtils.randFloat(-halfW, halfW) * 1.2;
    this.positions[i * 3 + 1] = anywhere ? THREE.MathUtils.randFloat(-halfH, halfH) : halfH * 1.1;
    this.positions[i * 3 + 2] = -z;
    this.speed[i] = THREE.MathUtils.randFloat(18, 40); // cm/s, real snow falls ~0.5-1 m/s
    this.phase[i] = Math.random() * Math.PI * 2;
  }

  update(dt) {
    this.time += dt;
    // A slow, gusty breeze shared by all flakes.
    const wind = Math.sin(this.time * 0.23) * 10 + Math.sin(this.time * 0.61) * 5;
    const p = this.positions;
    for (let i = 0; i < this.count; i++) {
      const ph = this.phase[i];
      p[i * 3] += (wind + Math.sin(this.time * 1.3 + ph) * 8) * dt;
      p[i * 3 + 1] -= this.speed[i] * dt;
      p[i * 3 + 2] += Math.cos(this.time * 0.9 + ph) * 2 * dt;

      const z = -p[i * 3 + 2];
      const halfH = z * this.tanHalfFov;
      const halfW = halfH * this.aspect * 1.25;
      if (p[i * 3 + 1] < -halfH * 1.1) this.respawn(i, false);
      else if (p[i * 3] > halfW) p[i * 3] -= 2 * halfW;
      else if (p[i * 3] < -halfW) p[i * 3] += 2 * halfW;
    }
    this.geometry.attributes.position.needsUpdate = true;
  }
}
