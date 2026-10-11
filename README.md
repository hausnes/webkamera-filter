# SantaCam – Webcam Santa Filter

Turn on your webcam and become Santa in real time: a 3D Santa hat with a swinging pom-pom, a fluffy beard and mustache that move with your face, and snow falling around (and behind) you. Uses MediaPipe for face tracking and person segmentation and three.js for rendering. Runs locally in your browser.

## Features
- Start/stop webcam safely.
- 3D Santa hat that follows your head's full pose (tilt, turn, nod), smoothed with a One Euro filter.
- Furry 3D beard and mustache that deform with your face: open your mouth and the beard drops with your jaw, smile and the mustache follows your upper lip.
- Occlusion: an invisible head and face model hide the parts of the hat and beard that are behind your head.
- Floppy hat tip simulated with verlet physics — shake your head and the pom-pom swings.
- Shell-rendered fur on the brim and pom-pom, and lighting that adapts to your room.
- Snow with depth of field; flakes in the background fall *behind* you thanks to selfie segmentation.
- Take a snapshot of the current frame with the filter.

## Prerequisites
- A modern desktop browser (Chrome, Edge, Firefox) with webcam access.
- Secure context: HTTPS or `http://localhost` is required for camera.
- Node.js 18+ recommended (to use the included local server).

## Quick Start (recommended)
Use the included Express server. It serves MediaPipe and three.js from `node_modules` and correct MIME types for `.wasm`.

```cmd
npm install
npm run start
```

Then open http://localhost:3000

### What the server does
- Serves the project root statically (index.html, script.js, styles.css).
- Exposes MediaPipe from `node_modules/@mediapipe/tasks-vision` under `/mediapipe`.
- Exposes three.js from `node_modules/three` under `/three` (addons under `/three/addons`).
- Ensures `.wasm` is served correctly so the browser can load the face landmarker.

## Alternative: Any static server
You can use another static server (e.g., Python SimpleHTTPServer), but you must ensure:
- `.wasm` is served as `application/wasm`.
- `.js` is served as `application/javascript`.
- The app can reach these paths:
	- `/mediapipe/vision_bundle.mjs` and WASM base path `/mediapipe/wasm`
	- `/three/three.module.js` and `/three/addons/`
	- Model files: `/vendor/mediapipe/models/face_landmarker.task` and `/vendor/mediapipe/models/selfie_segmenter.tflite`

If these paths don’t resolve (404 or MIME errors), prefer `npm run start` which configures them for you.

## How It Works
- `index.html` defines an import map for `three` and `@mediapipe/tasks-vision` and loads `script.js` as an ES module.
- `script.js` runs `FaceLandmarker` (with `outputFacialTransformationMatrixes`) to get the head pose as a 4×4 matrix in centimetres, and `ImageSegmenter` to get a person mask.
- Each frame is composited in WebGL in layers: webcam image → background snow → the webcam image again, cut out by the person mask → 3D hat and foreground snow.
- `src/santaHat.js` builds the hat in MediaPipe's canonical face space: a depth-only head ellipsoid for occlusion, the fur brim, and a hat body regenerated each frame around a physics-simulated spine.
- `src/faceRig.js` lifts the 2D face landmarks into 3D head space (using the depth of the matching canonical vertex) to get your live face shape, and drives a depth-only face mesh. `src/beard.js` builds the beard and mustache on the canonical face (`src/canonicalFace.js`, extracted from the model file) and skins them to the live face every frame.
- `src/fur.js` (shell fur shader), `src/snow.js` (particles) and `src/poseFilter.js` (One Euro smoothing) hold the supporting pieces.
- Add `?debug` to the URL to see the head occluder as a wireframe and log the pose alignment error to `window.__santaDebug`.
- `server.js` (Express) serves everything locally.

## Usage
1. Start the server and open the app.
2. Click `Start Camera` and grant permissions.
3. Keep your face well‑lit and shake your head to make the pom-pom swing. Talk or open your mouth to see the beard move. Toggle `Snow` on or off below the video.
4. Click `Take Snapshot` to save a PNG of the current frame.
5. Click `Stop Camera` to end the session.

## Troubleshooting
- Camera not starting: ensure you’re on `http://localhost` or HTTPS, and that the browser has permission to use the webcam.
- WASM or bundle load errors: use `npm run start` so assets resolve under `/mediapipe`; third‑party servers often mis‑serve `.wasm`.
- Model not found: verify `vendor/mediapipe/models/face_landmarker.task` exists and is accessible.
- Performance issues: close other camera apps, ensure good lighting, and keep only one face in frame. Turning off snow also skips person segmentation.

## Privacy
All processing is local in your browser; no images or video are uploaded.
