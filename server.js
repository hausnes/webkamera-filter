const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from project root
app.use(express.static(path.join(__dirname)));

// Serve mediapipe assets directly from node_modules
const mpRoot = path.join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision');
app.use('/mediapipe', express.static(mpRoot));
app.use('/mediapipe/wasm', express.static(path.join(mpRoot, 'wasm')));

// Serve three.js (core + addons) from node_modules
const threeRoot = path.join(__dirname, 'node_modules', 'three');
app.use('/three/addons', express.static(path.join(threeRoot, 'examples', 'jsm')));
app.use('/three', express.static(path.join(threeRoot, 'build')));

// Ensure correct MIME for WASM (Express 4.18+ sets application/wasm automatically for .wasm)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SantaCam server running at http://localhost:${PORT}`);
  console.log(`Serving MediaPipe from ${mpRoot}`);
});
