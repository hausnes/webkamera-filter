# SantaCam – Webcam Santa Filter

Turn on your webcam and overlay a Santa hat, beard, and mustache using MediaPipe Face Landmarker. Runs locally in your browser with JavaScript, HTML, and CSS.

## Features
- Start/stop webcam safely.
- Real‑time face landmarks via MediaPipe Tasks Vision.
- Santa hat + beard + mustache rendered on a canvas overlay.
- Take a snapshot of the current frame with the filter.

## Prerequisites
- A modern desktop browser (Chrome, Edge, Firefox) with webcam access.
- Secure context: HTTPS or `http://localhost` is required for camera.
- Node.js 18+ recommended (to use the included local server).

## Quick Start (recommended)
Use the included Express server. It serves MediaPipe assets from `node_modules` and correct MIME types for `.wasm`.

```cmd
npm install
npm run start
```

Then open http://localhost:3000

### What the server does
- Serves the project root statically (index.html, script.js, styles.css).
- Exposes MediaPipe from `node_modules/@mediapipe/tasks-vision` under `/mediapipe`.
- Ensures `.wasm` is served correctly so the browser can load the face landmarker.

## Alternative: Any static server
You can use another static server (e.g., Python SimpleHTTPServer), but you must ensure:
- `.wasm` is served as `application/wasm`.
- `.js` is served as `application/javascript`.
- The app can reach these paths:
	- `/mediapipe/wasm/vision_wasm_internal.js`
	- `/mediapipe/vision_bundle.mjs`
	- WASM base path: `/mediapipe/wasm`
	- Model file: `/vendor/mediapipe/models/face_landmarker.task`

If these paths don’t resolve (404 or MIME errors), prefer `npm run start` which configures them for you.

## How It Works
- `index.html` loads `vision_wasm_internal.js` and the ESM bundle `vision_bundle.mjs` from `/mediapipe`.
- `script.js` waits for the bundle, initializes `FaceLandmarker` via `FilesetResolver.forVisionTasks('/mediapipe/wasm')`, and uses the local model at `/vendor/mediapipe/models/face_landmarker.task`.
- Each animation frame detects face landmarks and draws the Santa hat, beard, and mustache on a canvas overlay positioned over the video.
- `server.js` (Express) serves everything locally and maps `/mediapipe` to `node_modules/@mediapipe/tasks-vision`.

## Usage
1. Start the server and open the app.
2. Click `Start Camera` and grant permissions.
3. Keep your face centered and well‑lit; the hat and beard track your movement.
4. Click `Take Snapshot` to save a PNG of the current frame.
5. Click `Stop Camera` to end the session.

## Troubleshooting
- Camera not starting: ensure you’re on `http://localhost` or HTTPS, and that the browser has permission to use the webcam.
- WASM or bundle load errors: use `npm run start` so assets resolve under `/mediapipe`; third‑party servers often mis‑serve `.wasm`.
- Model not found: verify `vendor/mediapipe/models/face_landmarker.task` exists and is accessible.
- Performance issues: close other camera apps, ensure good lighting, and keep only one face in frame.

## Privacy
All processing is local in your browser; no images or video are uploaded.
