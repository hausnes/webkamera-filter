/* SantaCam - Webcam Santa Claus Filter using MediaPipe FaceLandmarker */

const els = {
  video: document.getElementById('video'),
  canvas: document.getElementById('overlay'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  snapBtn: document.getElementById('snapBtn'),
  messages: document.getElementById('messages'),
  snapshotImg: document.getElementById('snapshotImg')
};

let stream = null;
let faceLandmarker = null;
let running = false;
let lastVideoSizeSet = false;

function setMessage(msg) { els.messages.textContent = msg; }

function waitForTasksVision(timeout = 6000) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    function check() {
      const tv = window.tasksVision;
      if (tv) return resolve(tv);
      if (performance.now() - start > timeout) {
        return reject(new Error('MediaPipe tasksVision bundle not loaded (timeout)'));
      }
      setTimeout(check, 100);
    }
    check();
  });
}

async function ensureFaceLandmarker() {
  if (faceLandmarker) return;
  setMessage('Loading face detection...');
  const tv = await waitForTasksVision().catch((e) => {
    console.error(e);
    throw e;
  });
  const { FaceLandmarker, FilesetResolver } = tv;
  const filesetResolver = await FilesetResolver.forVisionTasks(
    // Local base path for WASM assets served by Express from node_modules
    '/mediapipe/wasm'
  );
  faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    // Use local model under /vendor/mediapipe/models/
    baseOptions: { modelAssetPath: '/vendor/mediapipe/models/face_landmarker.task' },
    runningMode: 'VIDEO',
    numFaces: 1
  });
  setMessage('Face detection ready.');
}

function fitCanvasToVideo() {
  if (!els.video.videoWidth || !els.video.videoHeight) return;
  const w = els.video.videoWidth;
  const h = els.video.videoHeight;
  els.canvas.width = w;
  els.canvas.height = h;
  lastVideoSizeSet = true;
}

async function startCamera() {
  if (running) return;
  try {
    setMessage('Requesting camera access...');
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    els.video.srcObject = stream;
    await els.video.play();
    running = true;
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.snapBtn.disabled = false;
    await ensureFaceLandmarker();
    requestAnimationFrame(loop);
    setMessage('Camera started.');
  } catch (err) {
    console.error(err);
    setMessage('Failed to start camera: ' + (err.message || err));
  }
}

function stopCamera() {
  running = false;
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.snapBtn.disabled = true;
  setMessage('Camera stopped.');
}

function drawSanta(ctx, landmarks) {
  if (!landmarks || landmarks.length === 0) return;
  const points = landmarks[0];
  // Useful landmark indices (normalized [0..1])
  // Use some canonical points: 
  // - forehead approx: between left/right eyebrows
  // - chin: landmark 152 (MediaPipe canonical)
  // - nose tip: 4
  const get = (i) => points[i];
  const nose = get(4);
  const chin = get(152);
  const lBrow = get(70); // left eyebrow outer
  const rBrow = get(300); // right eyebrow outer

  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  // Convert normalized coords to pixels
  const toPx = (p) => ({ x: p.x * w, y: p.y * h });
  const nosePx = toPx(nose);
  const chinPx = toPx(chin);
  const lBrowPx = toPx(lBrow);
  const rBrowPx = toPx(rBrow);

  // Estimate face width using brow distance
  const faceWidth = Math.hypot(rBrowPx.x - lBrowPx.x, rBrowPx.y - lBrowPx.y);
  const hatWidth = faceWidth * 2.0;
  const beardWidth = faceWidth * 1.6;

  // Hat position: above eyebrows
  const browMid = { x: (lBrowPx.x + rBrowPx.x) / 2, y: (lBrowPx.y + rBrowPx.y) / 2 };
  const hatHeight = hatWidth * 0.5;
  const hatX = browMid.x - hatWidth / 2;
  const hatY = browMid.y - hatHeight - faceWidth * 0.15;

  // Beard position: around chin to above mouth (using nose as guide)
  const beardHeight = (chinPx.y - nosePx.y) * 1.4;
  const beardX = nosePx.x - beardWidth / 2;
  const beardY = nosePx.y + faceWidth * 0.15;

  // Draw hat (red triangle + white brim + pom-pom)
  ctx.save();
  ctx.globalAlpha = 0.95;

  // Red hat body
  ctx.fillStyle = '#d61f1f';
  ctx.beginPath();
  ctx.moveTo(hatX, hatY + hatHeight);
  ctx.lineTo(hatX + hatWidth, hatY + hatHeight);
  ctx.lineTo(browMid.x, hatY);
  ctx.closePath();
  ctx.fill();

  // White brim
  ctx.fillStyle = '#ffffff';
  const brimHeight = hatHeight * 0.18;
  ctx.fillRect(hatX, hatY + hatHeight - brimHeight, hatWidth, brimHeight);

  // Pom-pom
  ctx.beginPath();
  ctx.arc(browMid.x + hatWidth * 0.35, hatY + hatHeight * 0.12, brimHeight * 0.7, 0, Math.PI * 2);
  ctx.fill();

  // Beard (fluffy white)
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#ffffff';
  const segments = 16;
  for (let i = 0; i < segments; i++) {
    const t = i / (segments - 1);
    const bx = beardX + t * beardWidth;
    const jitter = Math.sin(t * Math.PI) * 6;
    const bh = beardHeight + (Math.sin(t * 2 * Math.PI) * 8);
    ctx.beginPath();
    ctx.ellipse(bx, beardY + bh / 2, beardWidth / 9, bh / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Mustache
  const stacheW = faceWidth * 0.9;
  const stacheH = faceWidth * 0.18;
  const stacheY = nosePx.y + faceWidth * 0.12;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(nosePx.x - stacheW * 0.22, stacheY, stacheW * 0.25, stacheH, 0, 0, Math.PI * 2);
  ctx.ellipse(nosePx.x + stacheW * 0.22, stacheY, stacheW * 0.25, stacheH, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

async function loop() {
  if (!running) return;
  if (!lastVideoSizeSet) fitCanvasToVideo();

  const ctx = els.canvas.getContext('2d');
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  try {
    if (faceLandmarker && els.video.readyState >= 2) {
      const res = faceLandmarker.detectForVideo(els.video, performance.now());
      if (res && res.faceLandmarks && res.faceLandmarks.length) {
        drawSanta(ctx, res.faceLandmarks);
      }
    }
  } catch (e) {
    console.warn('FaceLandmarker error:', e);
  }

  requestAnimationFrame(loop);
}

function takeSnapshot() {
  if (!running) return;
  const w = els.canvas.width;
  const h = els.canvas.height;
  const snapCanvas = document.createElement('canvas');
  snapCanvas.width = w;
  snapCanvas.height = h;
  const sctx = snapCanvas.getContext('2d');
  // Draw video frame then overlay
  sctx.drawImage(els.video, 0, 0, w, h);
  sctx.drawImage(els.canvas, 0, 0, w, h);
  els.snapshotImg.src = snapCanvas.toDataURL('image/png');
}

function checkSupport() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMessage('Your browser does not support webcam access.');
    els.startBtn.disabled = true;
    return false;
  }
  return true;
}

// Wire up events
els.startBtn.addEventListener('click', startCamera);
els.stopBtn.addEventListener('click', stopCamera);
els.snapBtn.addEventListener('click', takeSnapshot);

// Init
if (checkSupport()) {
  setMessage('Click "Start Camera" to begin.');
}
