/* =========================================================
   Human Verify - Puzzle Arena
   WindowsXP-shell "attendance system" captcha, 2-player arcade,
   gesture-controlled 3x3 photo restoration race.

   Nothing here ever leaves the browser: the captured photo lives
   only in memory / data URLs, and all face + hand recognition runs
   on-device via MediaPipe Tasks (WASM), never uploaded anywhere.
   ========================================================= */

(function () {
  'use strict';

  const CONFIG = {
    GRID: 3,
    DWELL_MS: 700,
    PINCH_DIST: 0.06,
    SELECT_COOLDOWN_MS: 450,
    VIDEO_W: 640,
    VIDEO_H: 480,
    MEDIAPIPE_VERSION: '0.10.14',
  };

  const CDN_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${CONFIG.MEDIAPIPE_VERSION}`;
  const WASM_BASE = `${CDN_BASE}/wasm`;
  const FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
  const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------
  // Screen management
  // ---------------------------------------------------------
  const screens = {
    consent: $('screen-consent'),
    capture: $('screen-capture'),
    scan: $('screen-scan'),
    countdown: $('screen-countdown'),
    arena: $('screen-arena'),
    results: $('screen-results'),
  };

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => { el.hidden = key !== name; });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  // ---------------------------------------------------------
  // Audio (synthesized, no asset files)
  // ---------------------------------------------------------
  let audioCtx = null;
  function ac() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  function beep(freq = 880, dur = 0.12, type = 'square', vol = 0.15) {
    try {
      const ctx = ac();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = vol;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.stop(ctx.currentTime + dur + 0.02);
    } catch (e) { /* audio not available, ignore */ }
  }
  const playSwapBeep = () => beep(520, 0.06, 'square', 0.08);
  const playCountBeep = () => beep(440, 0.15, 'square', 0.12);
  const playGoBeep = () => beep(880, 0.35, 'square', 0.16);
  const playWinFanfare = () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 0.18, 'square', 0.12), i * 110));

  // ---------------------------------------------------------
  // Camera
  // ---------------------------------------------------------
  let mediaStream = null;
  async function ensureCamera() {
    if (mediaStream) return mediaStream;
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: CONFIG.VIDEO_W, height: CONFIG.VIDEO_H, facingMode: 'user' },
      audio: false,
    });
    return mediaStream;
  }
  function stopCamera() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  // ---------------------------------------------------------
  // Consent screen
  // ---------------------------------------------------------
  $('btn-consent-agree').addEventListener('click', onConsentAgree);
  $('btn-consent-decline').addEventListener('click', () => {
    $('btn-consent-agree').closest('.msgbox').querySelector('.msgbox-text').insertAdjacentHTML(
      'beforeend', '<p class="msgbox-small" style="color:#c00 !important;">未同意开启摄像头，无法开始游戏。您可以随时重新点击"开始"。</p>'
    );
  });

  async function onConsentAgree() {
    showScreen('capture');
    const promptEl = $('prompt-text');
    try {
      await ensureCamera();
      $('video-feed').srcObject = mediaStream;
      $('avatar-video').srcObject = mediaStream;
      promptEl.textContent = '! CAMERA CONNECTED. TWO PLAYERS GET IN FRAME, CLICK 📷 TO CAPTURE.';
    } catch (err) {
      promptEl.textContent = '! CAMERA UNAVAILABLE — USE 📁 TO UPLOAD A GROUP PHOTO INSTEAD.';
    }
  }

  // ---------------------------------------------------------
  // Capture screen
  // ---------------------------------------------------------
  const captureCanvas = $('capture-canvas');
  let groupPhotoDataUrl = null;

  $('camera-btn').addEventListener('click', () => {
    const video = $('video-feed');
    if (!video.srcObject || !video.videoWidth) return;
    captureCanvas.width = video.videoWidth;
    captureCanvas.height = video.videoHeight;
    const ctx = captureCanvas.getContext('2d');
    ctx.translate(captureCanvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    groupPhotoDataUrl = captureCanvas.toDataURL('image/jpeg', 0.92);
    goToScan();
  });

  $('upload-btn').addEventListener('click', () => $('upload-input').click());
  $('upload-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { groupPhotoDataUrl = reader.result; goToScan(); };
    reader.readAsDataURL(file);
  });

  $('verify-btn').addEventListener('click', () => $('camera-btn').click());

  // ---------------------------------------------------------
  // Scan / face-detection screen
  // ---------------------------------------------------------
  let faceDetectorPromise = null;
  async function getFaceDetector() {
    if (!faceDetectorPromise) {
      faceDetectorPromise = (async () => {
        const { FilesetResolver, FaceDetector } = await import(`${CDN_BASE}/vision_bundle.mjs`);
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
        return FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: FACE_MODEL_URL },
          runningMode: 'IMAGE',
        });
      })();
    }
    return faceDetectorPromise;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function cropSquareDataUrl(img, cx, cy, size) {
    size = Math.max(24, Math.min(size, Math.min(img.naturalWidth, img.naturalHeight)));
    let sx = cx - size / 2;
    let sy = cy - size / 2;
    sx = Math.max(0, Math.min(sx, img.naturalWidth - size));
    sy = Math.max(0, Math.min(sy, img.naturalHeight - size));
    const c = document.createElement('canvas');
    c.width = 220; c.height = 220;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, sx, sy, size, size, 0, 0, 220, 220);
    return c.toDataURL('image/jpeg', 0.9);
  }

  let players = { 1: { avatar: null, box: null }, 2: { avatar: null, box: null } };

  async function goToScan() {
    showScreen('scan');
    const statusEl = $('scan-status');
    const continueBtn = $('scan-continue-btn');
    continueBtn.disabled = true;
    continueBtn.textContent = 'ANALYZING...';
    statusEl.textContent = '! ANALYZING PLAYERS...';

    const canvas = $('scan-canvas');
    const img = await loadImage(groupPhotoDataUrl);
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    let boxes = [];
    try {
      const detector = await getFaceDetector();
      const result = detector.detect(img);
      boxes = (result.detections || [])
        .map((d) => d.boundingBox)
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .slice(0, 4)
        .sort((a, b) => a.originX - b.originX);
    } catch (e) {
      console.warn('Face detection unavailable, using fallback split.', e);
    }

    let p1Box, p2Box;
    if (boxes.length >= 2) {
      p1Box = boxes[0];
      p2Box = boxes[boxes.length - 1];
      statusEl.textContent = '✔ 2 PLAYERS DETECTED VIA FACE RECOGNITION.';
    } else {
      const w = img.naturalWidth, h = img.naturalHeight;
      p1Box = { originX: 0, originY: 0, width: w / 2, height: h };
      p2Box = { originX: w / 2, originY: 0, width: w / 2, height: h };
      statusEl.textContent = '! COULD NOT ISOLATE 2 FACES — SPLIT FRAME LEFT/RIGHT INSTEAD.';
    }

    players[1].box = p1Box;
    players[2].box = p2Box;
    players[1].avatar = cropSquareDataUrl(img, p1Box.originX + p1Box.width / 2, p1Box.originY + p1Box.height / 2, Math.max(p1Box.width, p1Box.height) * 1.7);
    players[2].avatar = cropSquareDataUrl(img, p2Box.originX + p2Box.width / 2, p2Box.originY + p2Box.height / 2, Math.max(p2Box.width, p2Box.height) * 1.7);

    drawScanBoxes(ctx, [p1Box, p2Box]);
    $('avatar-1').style.backgroundImage = `url(${players[1].avatar})`;
    $('avatar-2').style.backgroundImage = `url(${players[2].avatar})`;

    continueBtn.disabled = false;
    continueBtn.textContent = 'READY? START GAME →';
  }

  function drawScanBoxes(ctx, boxes) {
    const labels = ['P1', 'P2'];
    boxes.forEach((b, i) => {
      ctx.strokeStyle = i === 0 ? '#35c3ff' : '#ff5fd1';
      ctx.lineWidth = Math.max(3, ctx.canvas.width * 0.006);
      ctx.strokeRect(b.originX, b.originY, b.width, b.height);
      ctx.fillStyle = ctx.strokeStyle;
      const fontSize = Math.max(16, ctx.canvas.width * 0.03);
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.fillText(labels[i], b.originX + 4, Math.max(fontSize, b.originY - 6));
    });
  }

  $('btn-retake').addEventListener('click', () => showScreen('capture'));
  $('scan-continue-btn').addEventListener('click', () => runCountdown());

  // ---------------------------------------------------------
  // Countdown
  // ---------------------------------------------------------
  async function runCountdown() {
    buildArena();
    showScreen('countdown');
    const el = $('countdown-number');
    const seq = ['3', '2', '1', 'GO!'];
    for (const label of seq) {
      el.textContent = label;
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = 'pop 0.5s ease-out';
      if (label === 'GO!') playGoBeep(); else playCountBeep();
      await sleep(700);
    }
    showScreen('arena');
    startGestureTracking();
    startTimers();
  }

  // ---------------------------------------------------------
  // Puzzle board
  // ---------------------------------------------------------
  const boards = { 1: null, 2: null };

  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  function isSorted(arr) {
    for (let i = 0; i < arr.length - 1; i++) if (arr[i] > arr[i + 1]) return false;
    return true;
  }

  class PuzzleBoard {
    constructor(el, playerId, imageDataUrl) {
      this.el = el;
      this.playerId = playerId;
      this.n = CONFIG.GRID;
      this.cells = [];
      this.pieces = [];
      this.selected = null;
      this.solved = false;
      this.el.classList.add('manual-off');
      this.buildFromImage(imageDataUrl);
    }

    buildFromImage(url) {
      this.el.innerHTML = '';
      this.pieces = [];
      const n = this.n;
      let order = [...Array(n * n).keys()];
      do { shuffleArray(order); } while (isSorted(order));
      this.cells = order.slice();

      for (let pos = 0; pos < n * n; pos++) {
        const piece = document.createElement('div');
        piece.className = 'puzzle-piece';
        piece.style.backgroundImage = `url(${url})`;
        piece.style.backgroundSize = `${n * 100}% ${n * 100}%`;
        piece.dataset.pos = String(pos);
        piece.setAttribute('draggable', 'true');
        const span = document.createElement('span');
        piece.appendChild(span);
        this.el.appendChild(piece);
        this.pieces.push(piece);
        this.attachManualHandlers(piece, pos);
      }
      this.renderAll();
    }

    attachManualHandlers(piece, pos) {
      piece.addEventListener('click', () => this.select(pos));

      piece.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(pos));
        piece.classList.add('dragging');
      });
      piece.addEventListener('dragend', () => {
        piece.classList.remove('dragging');
        this.pieces.forEach((p) => p.classList.remove('drag-over'));
      });
      piece.addEventListener('dragover', (e) => e.preventDefault());
      piece.addEventListener('dragenter', () => piece.classList.add('drag-over'));
      piece.addEventListener('dragleave', () => piece.classList.remove('drag-over'));
      piece.addEventListener('drop', (e) => {
        e.preventDefault();
        piece.classList.remove('drag-over');
        const from = Number(e.dataTransfer.getData('text/plain'));
        this.swap(from, pos);
      });
    }

    renderAll() { for (let pos = 0; pos < this.cells.length; pos++) this.renderPos(pos); }

    renderPos(pos) {
      const idx = this.cells[pos];
      const n = this.n;
      const col = idx % n, row = Math.floor(idx / n);
      const x = n === 1 ? 0 : (col / (n - 1)) * 100;
      const y = n === 1 ? 0 : (row / (n - 1)) * 100;
      const piece = this.pieces[pos];
      piece.style.backgroundPosition = `${x}% ${y}%`;
      piece.querySelector('span').textContent = String(idx + 1);
    }

    swap(posA, posB) {
      if (this.solved || posA === posB || Number.isNaN(posA) || Number.isNaN(posB)) return;
      const tmp = this.cells[posA];
      this.cells[posA] = this.cells[posB];
      this.cells[posB] = tmp;
      this.renderPos(posA);
      this.renderPos(posB);
      playSwapBeep();
      this.checkSolved();
    }

    select(pos) {
      if (this.solved) return;
      if (this.selected === null) {
        this.selected = pos;
        this.pieces[pos].classList.add('selected');
      } else if (this.selected === pos) {
        this.pieces[pos].classList.remove('selected');
        this.selected = null;
      } else {
        this.pieces[this.selected].classList.remove('selected');
        const prev = this.selected;
        this.selected = null;
        this.swap(prev, pos);
      }
    }

    checkSolved() {
      const win = this.cells.every((v, i) => v === i);
      if (win) {
        this.solved = true;
        this.pieces.forEach((p) => {
          p.classList.add('solved');
          p.setAttribute('draggable', 'false');
        });
        onPlayerSolved(this.playerId);
      }
    }
  }

  function buildArena() {
    boards[1] = new PuzzleBoard($('board-1'), 1, groupPhotoDataUrl);
    boards[2] = new PuzzleBoard($('board-2'), 2, groupPhotoDataUrl);
    $('winflag-1').classList.remove('show');
    $('winflag-2').classList.remove('show');
    document.querySelectorAll('.manual-toggle').forEach((btn) => btn.classList.remove('active'));
  }

  document.querySelectorAll('.manual-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pid = Number(btn.dataset.player);
      const board = boards[pid];
      if (!board) return;
      const on = board.el.classList.toggle('manual-off') === false;
      btn.classList.toggle('active', on);
      btn.textContent = on ? '🖱 手动模式：开 / ON' : '🖱 手动模式 / Manual';
    });
  });

  function enableManualModeForAll() {
    [1, 2].forEach((pid) => {
      const board = boards[pid];
      if (!board) return;
      board.el.classList.remove('manual-off');
      const btn = document.querySelector(`.manual-toggle[data-player="${pid}"]`);
      if (btn) { btn.classList.add('active'); btn.textContent = '🖱 手动模式：开 / ON'; }
    });
  }

  // ---------------------------------------------------------
  // Timers
  // ---------------------------------------------------------
  const timers = {
    1: { start: 0, raf: null, elapsed: 0, finished: false },
    2: { start: 0, raf: null, elapsed: 0, finished: false },
  };

  function formatTime(ms) {
    const totalSec = ms / 1000;
    const m = Math.floor(totalSec / 60);
    const sec = (totalSec % 60).toFixed(1).padStart(4, '0');
    return `${String(m).padStart(2, '0')}:${sec}`;
  }

  function startTimers() {
    const now = performance.now();
    [1, 2].forEach((p) => {
      timers[p].start = now;
      timers[p].finished = false;
      timers[p].elapsed = 0;
      tick(p);
    });
  }

  function tick(p) {
    const t = timers[p];
    if (t.finished) return;
    t.elapsed = performance.now() - t.start;
    $('timer-' + p).textContent = formatTime(t.elapsed);
    t.raf = requestAnimationFrame(() => tick(p));
  }

  function onPlayerSolved(playerId) {
    const t = timers[playerId];
    if (t.finished) return;
    t.finished = true;
    if (t.raf) cancelAnimationFrame(t.raf);
    $('timer-' + playerId).textContent = formatTime(t.elapsed);
    $('winflag-' + playerId).classList.add('show');
    playWinFanfare();
    checkBothFinished();
  }

  function checkBothFinished() {
    if (timers[1].finished && timers[2].finished) {
      setTimeout(showResults, 900);
    }
  }

  function showResults() {
    const t1 = timers[1].elapsed, t2 = timers[2].elapsed;
    $('result-time-1').textContent = formatTime(t1);
    $('result-time-2').textContent = formatTime(t2);
    const winnerEl = $('results-winner');
    if (t1 < t2) winnerEl.textContent = '🏆 PLAYER 1 WINS!';
    else if (t2 < t1) winnerEl.textContent = '🏆 PLAYER 2 WINS!';
    else winnerEl.textContent = '🤝 DRAW!';
    showScreen('results');
    stopGestureTracking();
  }

  $('btn-play-again').addEventListener('click', () => {
    showScreen('capture');
  });

  // ---------------------------------------------------------
  // Gesture tracking (MediaPipe HandLandmarker)
  // ---------------------------------------------------------
  let handLandmarker = null;
  let handLoopActive = false;
  const gestureState = {
    1: { lastCell: -1, dwellStart: 0, lastTrigger: 0, wasPinch: false },
    2: { lastCell: -1, dwellStart: 0, lastTrigger: 0, wasPinch: false },
  };
  let lastPromptState = null;

  function setArenaPrompt(text, ok) {
    const el = $('arena-prompt');
    if (lastPromptState === text) return;
    lastPromptState = text;
    el.textContent = text;
    el.classList.toggle('ok', !!ok);
  }

  async function startGestureTracking() {
    const gestureVideo = $('gesture-video');
    try {
      if (!mediaStream) await ensureCamera();
      gestureVideo.srcObject = mediaStream;
    } catch (e) {
      setArenaPrompt('⚠ NO CAMERA — MANUAL MODE ACTIVE FOR BOTH PLAYERS', false);
      enableManualModeForAll();
      return;
    }

    try {
      const { FilesetResolver, HandLandmarker } = await import(`${CDN_BASE}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      handLandmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL },
        runningMode: 'VIDEO',
        numHands: 2,
      });
    } catch (e) {
      console.warn('Gesture tracking unavailable, falling back to manual mode.', e);
      setArenaPrompt('⚠ GESTURE MODULE UNAVAILABLE — USE 🖱 MANUAL MODE BELOW', false);
      enableManualModeForAll();
      return;
    }

    setArenaPrompt('✋ SHOW YOUR HAND — HOVER (0.7s) OR PINCH A TILE TO SWAP', true);
    handLoopActive = true;
    gestureState[1] = { lastCell: -1, dwellStart: 0, lastTrigger: 0, wasPinch: false };
    gestureState[2] = { lastCell: -1, dwellStart: 0, lastTrigger: 0, wasPinch: false };
    requestAnimationFrame(predictLoop);
  }

  function stopGestureTracking() {
    handLoopActive = false;
    hideCursor(1);
    hideCursor(2);
  }

  function predictLoop(nowTs) {
    if (!handLoopActive) return;
    const video = $('gesture-video');
    if (handLandmarker && video.readyState >= 2) {
      const result = handLandmarker.detectForVideo(video, performance.now());
      processHands(result, performance.now());
      drawSkeleton(result);
    }
    requestAnimationFrame(predictLoop);
  }

  function processHands(result, now) {
    const landmarks = result.landmarks || [];
    const seen = new Set();

    landmarks.forEach((lm) => {
      const indexTip = lm[8];
      const thumbTip = lm[4];
      const mx = 1 - indexTip.x; // mirror to match displayed (selfie) view
      const my = clamp01(indexTip.y);
      const playerId = mx < 0.5 ? 1 : 2;
      seen.add(playerId);

      const localX = playerId === 1 ? mx / 0.5 : (mx - 0.5) / 0.5;
      const localY = my;
      updateCursor(playerId, localX, localY);

      const dist = Math.hypot(
        indexTip.x - thumbTip.x,
        indexTip.y - thumbTip.y,
        (indexTip.z || 0) - (thumbTip.z || 0)
      );
      const pinching = dist < CONFIG.PINCH_DIST;
      setPinchVisual(playerId, pinching);
      handleHover(playerId, localX, localY, pinching, now);
    });

    [1, 2].forEach((p) => {
      if (!seen.has(p)) {
        hideCursor(p);
        gestureState[p].dwellStart = 0;
        gestureState[p].lastCell = -1;
        gestureState[p].wasPinch = false;
      }
    });

    if (landmarks.length === 0) setArenaPrompt('⚠ SHOW YOUR HAND(S) TO THE CAMERA', false);
    else setArenaPrompt(`✋ TRACKING ${landmarks.length} HAND(S) — HOVER OR PINCH TO SWAP`, true);
  }

  function handleHover(playerId, lx, ly, pinching, now) {
    const board = boards[playerId];
    const st = gestureState[playerId];
    if (!board || board.solved) return;
    if (lx < 0 || lx > 1 || ly < 0 || ly > 1) { st.dwellStart = 0; st.lastCell = -1; return; }

    const n = CONFIG.GRID;
    const col = Math.min(n - 1, Math.floor(lx * n));
    const row = Math.min(n - 1, Math.floor(ly * n));
    const pos = row * n + col;

    if (pinching && !st.wasPinch && now - st.lastTrigger > CONFIG.SELECT_COOLDOWN_MS) {
      board.select(pos);
      st.lastTrigger = now;
      st.dwellStart = 0;
    }
    st.wasPinch = pinching;

    if (!pinching) {
      if (st.lastCell !== pos) {
        st.lastCell = pos;
        st.dwellStart = now;
      } else if (st.dwellStart && now - st.dwellStart > CONFIG.DWELL_MS && now - st.lastTrigger > CONFIG.SELECT_COOLDOWN_MS) {
        board.select(pos);
        st.lastTrigger = now;
        st.dwellStart = now;
      }
    }
  }

  function updateCursor(playerId, lx, ly) {
    const el = $('cursor-' + playerId);
    el.style.display = (lx < 0 || lx > 1 || ly < 0 || ly > 1) ? 'none' : 'block';
    el.style.left = `${clamp01(lx) * 100}%`;
    el.style.top = `${clamp01(ly) * 100}%`;
  }
  function hideCursor(playerId) { $('cursor-' + playerId).style.display = 'none'; }
  function setPinchVisual(playerId, pinching) { $('cursor-' + playerId).classList.toggle('pinch', pinching); }

  function drawSkeleton(result) {
    const canvas = $('gesture-overlay');
    const video = $('gesture-video');
    if (!canvas.width || canvas.width !== video.clientWidth) {
      canvas.width = video.clientWidth;
      canvas.height = video.clientHeight;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const CONNECTIONS = [
      [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
      [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17],
    ];
    (result.landmarks || []).forEach((lm, hi) => {
      const color = hi % 2 === 0 ? '#35c3ff' : '#ff5fd1';
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
      ctx.beginPath();
      CONNECTIONS.forEach(([a, b]) => {
        const pa = lm[a], pb = lm[b];
        ctx.moveTo((1 - pa.x) * canvas.width, pa.y * canvas.height);
        ctx.lineTo((1 - pb.x) * canvas.width, pb.y * canvas.height);
      });
      ctx.stroke();
      lm.forEach((p) => {
        ctx.beginPath();
        ctx.arc((1 - p.x) * canvas.width, p.y * canvas.height, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  }

  // ---------------------------------------------------------
  // Window chrome (decorative + reset)
  // ---------------------------------------------------------
  $('xp-close').addEventListener('click', resetAll);
  $('btn-reset-all').addEventListener('click', resetAll);
  $('btn-close').addEventListener('click', resetAll);
  $('xp-max').addEventListener('click', () => $('xp-window').classList.toggle('maximized'));

  function resetAll() {
    handLoopActive = false;
    Object.values(timers).forEach((t) => { if (t.raf) cancelAnimationFrame(t.raf); t.finished = true; });
    stopCamera();
    groupPhotoDataUrl = null;
    boards[1] = boards[2] = null;
    showScreen('consent');
  }

  function tickClock() {
    const now = new Date();
    $('xp-clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  tickClock();
  setInterval(tickClock, 15000);

  // ---------------------------------------------------------
  // Public mount API (for later embedding as the first minigame
  // inside a larger game shell)
  // ---------------------------------------------------------
  window.HumanVerifyPuzzleGame = {
    restart: resetAll,
    getResult: () => ({
      player1Ms: timers[1].elapsed,
      player2Ms: timers[2].elapsed,
      winner: timers[1].elapsed === timers[2].elapsed ? null : (timers[1].elapsed < timers[2].elapsed ? 1 : 2),
    }),
  };

  showScreen('consent');
})();
