/* SantaCam - 3D Santa hat webcam filter.
 *
 * MediaPipe FaceLandmarker gives us the head pose as a 4x4 matrix, and the
 * selfie ImageSegmenter tells us which pixels are the person. three.js then
 * composites each frame in layers:
 *
 *   1. the webcam image
 *   2. snow far away (behind you)
 *   3. the webcam image again, cut out by the person mask, so you cover that snow
 *   4. the 3D hat and beard (occluded by an invisible head and face) and snow
 *      close to the camera
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FaceLandmarker, FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { SantaHat } from './src/santaHat.js';
import { Beard } from './src/beard.js';
import { FaceRig } from './src/faceRig.js';
import { setFurLighting } from './src/fur.js';
import { Snow } from './src/snow.js';
import { PoseFilter } from './src/poseFilter.js';

const els = {
  stage: document.getElementById('stage'),
  video: document.getElementById('video'),
  canvas: document.getElementById('overlay'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  snapBtn: document.getElementById('snapBtn'),
  snowToggle: document.getElementById('snowToggle'),
  messages: document.getElementById('messages'),
  snapshotImg: document.getElementById('snapshotImg')
};

const DEBUG = new URLSearchParams(location.search).has('debug');
// MediaPipe's face geometry assumes a perspective camera with this vertical FOV.
const CAMERA_FOV_Y = 63;
const FACE_LOST_GRACE_MS = 300;
const LIGHT_DIRECTION = new THREE.Vector3(-0.35, 0.85, 0.55).normalize();

let stream = null;
let running = false;
let faceLandmarker = null;
let segmenter = null;
let lastVideoTime = -1;
let lastFrameTime = 0;
let lastTimestamp = 0;
let lastFaceSeen = 0;
let frameCount = 0;
let snapshotRequested = false;

function setMessage(msg) { els.messages.textContent = msg; }

// ---------------------------------------------------------------------------
// three.js setup

const renderer = new THREE.WebGLRenderer({ canvas: els.canvas, antialias: true });
renderer.setPixelRatio(1); // the canvas is sized to the video resolution
renderer.autoClear = false;
renderer.toneMapping = THREE.NeutralToneMapping;

const camera = new THREE.PerspectiveCamera(CAMERA_FOV_Y, 16 / 9, 1, 10000);
const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const videoTexture = new THREE.VideoTexture(els.video);
videoTexture.colorSpace = THREE.SRGBColorSpace;

const maskTexture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
maskTexture.magFilter = THREE.LinearFilter;
maskTexture.minFilter = THREE.LinearFilter;
// Mask rows start at the top of the image; flip it to match the video texture.
maskTexture.repeat.set(1, -1);
maskTexture.offset.set(0, 1);
let maskData = null;

function fullscreenQuad(material) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return scene;
}

const backgroundLayer = fullscreenQuad(
  new THREE.MeshBasicMaterial({ map: videoTexture, toneMapped: false, depthTest: false, depthWrite: false })
);
const personLayer = fullscreenQuad(
  new THREE.MeshBasicMaterial({
    map: videoTexture,
    alphaMap: maskTexture,
    transparent: true,
    toneMapped: false,
    depthTest: false,
    depthWrite: false
  })
);

// Flakes are oversized compared to real snow so they read at webcam resolution.
const backSnow = new Snow({ count: 1600, depth: [70, 400], size: [1.8, 4.0] });
const frontSnow = new Snow({ count: 60, depth: [12, 35], size: [0.25, 0.5], opacity: 0.7 });
const backSnowLayer = new THREE.Scene();
backSnowLayer.add(backSnow.points);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x404050, 0.9);
scene.add(hemiLight);
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
scene.add(keyLight, keyLight.target);

const hat = new SantaHat(scene, { debug: DEBUG });
const faceRig = new FaceRig(hat.head, { debug: DEBUG });
const beard = new Beard(hat.head);
let landmarks = null;
scene.add(frontSnow.points);

const poseFilter = new PoseFilter();
const rawPose = new THREE.Matrix4();
const smoothPose = new THREE.Matrix4();
const headPosition = new THREE.Vector3();

function resizeToVideo() {
  const w = els.video.videoWidth;
  const h = els.video.videoHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  backSnow.setView(camera, h);
  frontSnow.setView(camera, h);
  els.stage.style.setProperty('--video-aspect', `${w} / ${h}`);
}

// ---------------------------------------------------------------------------
// Lighting estimate: match the hat's brightness and tint to the room.

const lightProbe = document.createElement('canvas');
lightProbe.width = 24;
lightProbe.height = 14;
const lightProbeCtx = lightProbe.getContext('2d', { willReadFrequently: true });
const lightTint = new THREE.Color(1, 1, 1);
let lightLevel = 1;

function estimateLighting() {
  lightProbeCtx.drawImage(els.video, 0, 0, lightProbe.width, lightProbe.height);
  const px = lightProbeCtx.getImageData(0, 0, lightProbe.width, lightProbe.height).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
  const n = (px.length / 4) * 255;
  r /= n; g /= n; b /= n;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const targetLevel = THREE.MathUtils.clamp(luminance / 0.45, 0.45, 1.4);
  const max = Math.max(r, g, b, 1e-3);
  const target = new THREE.Color(r / max, g / max, b / max).lerp(new THREE.Color(1, 1, 1), 0.6);
  // Ease towards the estimate so auto-exposure flicker doesn't pump the lights.
  lightLevel += (targetLevel - lightLevel) * 0.2;
  lightTint.lerp(target, 0.2);

  keyLight.color.copy(lightTint);
  keyLight.intensity = 2.2 * lightLevel;
  hemiLight.intensity = 0.9 * lightLevel;
  scene.environmentIntensity = 0.5 * lightLevel;
  setFurLighting(
    [...hat.furMaterials, ...beard.materials],
    LIGHT_DIRECTION,
    lightTint.clone().multiplyScalar(0.85 * lightLevel),
    new THREE.Color(0.32, 0.34, 0.4).multiplyScalar(lightLevel)
  );
}

// ---------------------------------------------------------------------------
// MediaPipe

async function createWithGpuFallback(create) {
  try {
    return await create('GPU');
  } catch (err) {
    console.warn('GPU delegate unavailable, falling back to CPU:', err);
    return create('CPU');
  }
}

async function ensureModels() {
  if (faceLandmarker) return;
  setMessage('Loading face tracking...');
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');

  faceLandmarker = await createWithGpuFallback((delegate) =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/vendor/mediapipe/models/face_landmarker.task', delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFacialTransformationMatrixes: true
    })
  );

  // Snow behind you needs the person mask; without it all snow just falls in front.
  try {
    segmenter = await createWithGpuFallback((delegate) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/vendor/mediapipe/models/selfie_segmenter.tflite', delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false
      })
    );
  } catch (err) {
    console.warn('Selfie segmentation unavailable:', err);
  }
}

function updatePersonMask(timestamp) {
  const result = segmenter.segmentForVideo(els.video, timestamp);
  const masks = result.confidenceMasks;
  if (masks && masks.length) {
    // Multi-class models put background first; the selfie model has a single person channel.
    const mask = masks[masks.length - 1];
    const values = mask.getAsFloat32Array();
    const { width, height } = mask;
    if (!maskData || maskTexture.image.width !== width || maskTexture.image.height !== height) {
      maskData = new Uint8Array(width * height * 4);
      maskTexture.dispose();
      maskTexture.image = { data: maskData, width, height };
    }
    for (let i = 0; i < values.length; i++) {
      // Light temporal smoothing hides frame-to-frame flicker at the edges.
      const v = maskData[i * 4] * 0.4 + values[i] * 255 * 0.6;
      maskData[i * 4] = maskData[i * 4 + 1] = maskData[i * 4 + 2] = maskData[i * 4 + 3] = v;
    }
    maskTexture.needsUpdate = true;
  }
  result.close?.();
}

function detect(now) {
  // Timestamps must strictly increase for VIDEO mode.
  const timestamp = Math.max(now, lastTimestamp + 1);
  lastTimestamp = timestamp;

  const result = faceLandmarker.detectForVideo(els.video, timestamp);
  const matrices = result.facialTransformationMatrixes;
  if (matrices && matrices.length) {
    rawPose.fromArray(matrices[0].data);
    landmarks = result.faceLandmarks[0];
    lastFaceSeen = now;
    if (DEBUG) reportProjectionError(result.faceLandmarks[0]);
  }

  if (segmenter && els.snowToggle.checked) updatePersonMask(timestamp);
}

/** Debug aid: how far (in pixels) the 3D nose tip lands from the detected one. */
function reportProjectionError(landmarks) {
  const nose = new THREE.Vector3(0, -0.46, 7.59).applyMatrix4(rawPose).project(camera);
  const dx = ((nose.x + 1) / 2 - landmarks[4].x) * els.video.videoWidth;
  const dy = ((1 - nose.y) / 2 - landmarks[4].y) * els.video.videoHeight;
  window.__santaDebug = { noseErrorPx: Math.hypot(dx, dy), matrix: Array.from(rawPose.elements) };
}

// ---------------------------------------------------------------------------
// Frame loop

function render(now) {
  if (!running) return;
  const dt = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, 0.1) : 1 / 60;
  lastFrameTime = now;

  if (els.video.readyState >= 2) {
    if (els.video.currentTime !== lastVideoTime) {
      lastVideoTime = els.video.currentTime;
      try {
        detect(now);
      } catch (err) {
        console.warn('Detection error:', err);
      }
    }
    if (frameCount++ % 10 === 0) estimateLighting();
  }

  const faceVisible = lastFaceSeen && now - lastFaceSeen < FACE_LOST_GRACE_MS;
  if (faceVisible) {
    poseFilter.filter(rawPose, dt, smoothPose);
    hat.setVisible(true);
    hat.update(smoothPose, dt);
    faceRig.update(landmarks, smoothPose, camera);
    beard.update(faceRig.displacement);
    headPosition.setFromMatrixPosition(smoothPose);
    keyLight.target.position.copy(headPosition);
    keyLight.position.copy(headPosition).addScaledVector(LIGHT_DIRECTION, 100);
  } else {
    hat.setVisible(false);
    poseFilter.reset();
    faceRig.reset();
  }

  const snowOn = els.snowToggle.checked;
  backSnow.points.visible = frontSnow.points.visible = snowOn;
  if (snowOn) {
    backSnow.update(dt);
    frontSnow.update(dt);
  }

  renderer.clear();
  renderer.render(backgroundLayer, screenCamera);
  if (snowOn) {
    renderer.render(backSnowLayer, camera);
    if (segmenter && maskData) renderer.render(personLayer, screenCamera);
  }
  renderer.clearDepth();
  renderer.render(scene, camera);

  // Read back right after rendering, before the browser clears the drawing buffer.
  if (snapshotRequested) {
    snapshotRequested = false;
    saveSnapshot();
  }

  requestAnimationFrame(render);
}

function saveSnapshot() {
  const src = renderer.domElement;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  // Mirror to match the on-screen preview.
  ctx.translate(out.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(src, 0, 0);
  els.snapshotImg.src = out.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Camera controls

async function startCamera() {
  if (running) return;
  try {
    els.startBtn.disabled = true;
    setMessage('Requesting camera access...');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    els.video.srcObject = stream;
    await els.video.play();
    resizeToVideo();
    await ensureModels();
    running = true;
    lastFrameTime = 0;
    els.stopBtn.disabled = false;
    els.snapBtn.disabled = false;
    requestAnimationFrame(render);
    setMessage('Camera started. Shake your head! 🎅');
  } catch (err) {
    console.error(err);
    els.startBtn.disabled = false;
    setMessage('Failed to start camera: ' + (err.message || err));
  }
}

function stopCamera() {
  running = false;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  lastFaceSeen = 0;
  hat.setVisible(false);
  poseFilter.reset();
  renderer.clear();
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.snapBtn.disabled = true;
  setMessage('Camera stopped.');
}

function checkSupport() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMessage('Your browser does not support webcam access.');
    els.startBtn.disabled = true;
    return false;
  }
  return true;
}

els.startBtn.addEventListener('click', startCamera);
els.stopBtn.addEventListener('click', stopCamera);
els.snapBtn.addEventListener('click', () => { if (running) snapshotRequested = true; });
els.video.addEventListener('resize', resizeToVideo);

if (checkSupport()) {
  setMessage('Click "Start Camera" to begin.');
}
