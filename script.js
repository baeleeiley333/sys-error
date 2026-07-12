/* =========================================================
   Human Verify - Puzzle Arena
   WindowsXP-shell "attendance system" captcha that leads into a
   pixel-arcade 1v1 duel: GAME START -> VS intro -> Player 1's turn
   (avatar jump/glow/enlarge, 3-2-1 countdown, huge timer, gesture-
   controlled 3x3 photo restore) -> Player 2's turn -> Roger the dog
   judges the winner.

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
    gamestart: $('screen-gamestart'),
    vs: $('screen-vs'),
    duel: $('screen-duel'),
    judge: $('screen-judge'),
  };

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => { el.hidden = key !== name; });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function restartAnimation(el) {
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }

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
  const playGameStartFanfare = () => [392, 523, 659, 784].forEach((f, i) => setTimeout(() => beep(f, 0.16, 'square', 0.13), i * 90));
  const playVsSting = () => [220, 174].forEach((f, i) => setTimeout(() => beep(f, 0.22, 'sawtooth', 0.1), i * 130));

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
    $('btn-consent-agree').closest('.clippy-bubble').insertAdjacentHTML(
      'beforeend', '<p class="msgbox-small" style="color:#c00 !important;">Camera access declined — click START any time to try again.</p>'
    );
  });

  async function onConsentAgree() {
    await enterCaptureScreen();
  }

  // ---------------------------------------------------------
  // Capture screen — auto-captures when both players hold up a
  // peace sign (✌️) together; the manual 📷 button always works too.
  // ---------------------------------------------------------
  const captureCanvas = $('capture-canvas');
  let groupPhotoDataUrl = null;
  let lastHandAnchors = null; // {x,y} (mirrored, 0..1) of the 2 peace-sign hands at capture time, or null

  async function enterCaptureScreen() {
    showScreen('capture');
    const promptEl = $('prompt-text');
    $('upload-btn').classList.remove('pulse-highlight');
    try {
      await ensureCamera();
      $('video-feed').srcObject = mediaStream;
      $('avatar-video').srcObject = mediaStream;
      promptEl.textContent = '! CAMERA CONNECTED. BOTH PLAYERS SHOW A ✌️ PEACE SIGN TO AUTO-CAPTURE (or click 📷).';
      startCaptureGestureWatch();
    } catch (err) {
      promptEl.textContent = '! CAMERA UNAVAILABLE — click 📁 below to upload a group photo instead';
      $('capture-area').innerHTML = '<div id="no-camera-hint">📁<br />No camera access<br /><span>Click the 📁 button in the toolbar below to upload a group photo</span></div>';
      $('upload-btn').classList.add('pulse-highlight');
    }
  }

  function doCapturePhoto(anchors) {
    const video = $('video-feed');
    if (!video.srcObject || !video.videoWidth) return;
    stopCaptureGestureWatch();
    captureCanvas.width = video.videoWidth;
    captureCanvas.height = video.videoHeight;
    const ctx = captureCanvas.getContext('2d');
    ctx.translate(captureCanvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    groupPhotoDataUrl = captureCanvas.toDataURL('image/jpeg', 0.92);
    lastHandAnchors = anchors || null;
    goToScan();
  }

  $('camera-btn').addEventListener('click', () => doCapturePhoto(null));

  $('upload-btn').addEventListener('click', () => $('upload-input').click());
  $('upload-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    stopCaptureGestureWatch();
    const reader = new FileReader();
    reader.onload = () => { groupPhotoDataUrl = reader.result; lastHandAnchors = null; goToScan(); };
    reader.readAsDataURL(file);
  });

  $('verify-btn').addEventListener('click', () => $('camera-btn').click());

  // ---------------------------------------------------------
  // Shared MediaPipe HandLandmarker (used by both the capture-screen
  // peace-sign watch and the duel-screen tile-swap gestures)
  // ---------------------------------------------------------
  let handLandmarkerPromise = null;
  async function getHandLandmarker() {
    if (!handLandmarkerPromise) {
      handLandmarkerPromise = (async () => {
        const { FilesetResolver, HandLandmarker } = await import(`${CDN_BASE}/vision_bundle.mjs`);
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
        return HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: HAND_MODEL_URL },
          runningMode: 'VIDEO',
          numHands: 2,
        });
      })();
    }
    return handLandmarkerPromise;
  }

  function fingerExtended(lm, tipIdx, pipIdx) {
    const tip = lm[tipIdx], pip = lm[pipIdx], wrist = lm[0];
    const dTip = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
    const dPip = Math.hypot(pip.x - wrist.x, pip.y - wrist.y);
    return dTip > dPip * 1.15;
  }
  function isPeaceSign(lm) {
    return fingerExtended(lm, 8, 6) && fingerExtended(lm, 12, 10) &&
      !fingerExtended(lm, 16, 14) && !fingerExtended(lm, 20, 18);
  }

  const PEACE_HOLD_MS = 700;
  let captureLoopActive = false;
  let peaceHoldStart = 0;
  let captureHandLandmarker = null;

  async function startCaptureGestureWatch() {
    if (!mediaStream) return;
    try {
      captureHandLandmarker = await getHandLandmarker();
    } catch (e) {
      console.warn('Peace-sign auto-capture unavailable, use the 📷 button manually.', e);
      return;
    }
    captureLoopActive = true;
    peaceHoldStart = 0;
    requestAnimationFrame(captureGestureLoop);
  }

  function stopCaptureGestureWatch() {
    captureLoopActive = false;
  }

  function captureGestureLoop() {
    if (!captureLoopActive) return;
    const video = $('video-feed');
    const promptEl = $('prompt-text');
    if (captureHandLandmarker && video.readyState >= 2) {
      const result = captureHandLandmarker.detectForVideo(video, performance.now());
      const lms = result.landmarks || [];
      const peaceHands = lms.filter(isPeaceSign);

      if (peaceHands.length >= 2) {
        if (!peaceHoldStart) peaceHoldStart = performance.now();
        const remaining = Math.max(0, PEACE_HOLD_MS - (performance.now() - peaceHoldStart));
        promptEl.textContent = `✌️✌️ PEACE SIGNS DETECTED — HOLD STILL... CAPTURING IN ${(remaining / 1000).toFixed(1)}s`;
        if (remaining <= 0) {
          const anchors = peaceHands.slice(0, 2).map((lm) => ({ x: clamp01(1 - lm[8].x), y: clamp01(lm[8].y) }));
          doCapturePhoto(anchors);
          return;
        }
      } else {
        peaceHoldStart = 0;
        promptEl.textContent = lms.length > 0
          ? `✌️ ${peaceHands.length}/2 PEACE SIGNS — BOTH PLAYERS SHOW ✌️ TO AUTO-CAPTURE`
          : '! CAMERA CONNECTED. BOTH PLAYERS SHOW A ✌️ PEACE SIGN TO AUTO-CAPTURE (or click 📷).';
      }
    }
    requestAnimationFrame(captureGestureLoop);
  }

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

  function anchorToBox(anchor, w, h, size) {
    const cx = anchor.x * w;
    const cy = Math.max(size / 2, anchor.y * h - h * 0.12); // bias up from the raised hand toward the face
    return { originX: cx - size / 2, originY: cy - size / 2, width: size, height: size };
  }

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
      console.warn('Face detection unavailable.', e);
    }

    let p1Box, p2Box, drawBoxes = false;
    const w = img.naturalWidth, h = img.naturalHeight;

    if (boxes.length >= 2) {
      p1Box = boxes[0];
      p2Box = boxes[boxes.length - 1];
      drawBoxes = true;
      statusEl.textContent = '✔ 2 PLAYERS DETECTED VIA FACE RECOGNITION.';
    } else if (lastHandAnchors && lastHandAnchors.length >= 2) {
      const sorted = [...lastHandAnchors].sort((a, b) => a.x - b.x);
      const size = Math.min(w, h) * 0.42;
      p1Box = anchorToBox(sorted[0], w, h, size);
      p2Box = anchorToBox(sorted[1], w, h, size);
      statusEl.textContent = '! FACE MODEL UNAVAILABLE — CROPPED FROM YOUR PEACE-SIGN HAND POSITIONS INSTEAD.';
    } else {
      const size = Math.min(w, h) * 0.4;
      p1Box = { originX: w * 0.28 - size / 2, originY: h * 0.12, width: size, height: size };
      p2Box = { originX: w * 0.72 - size / 2, originY: h * 0.12, width: size, height: size };
      statusEl.textContent = '! COULD NOT DETECT PLAYERS — USING DEFAULT CROPS.';
    }

    players[1].box = p1Box;
    players[2].box = p2Box;
    players[1].avatar = cropSquareDataUrl(img, p1Box.originX + p1Box.width / 2, p1Box.originY + p1Box.height / 2, Math.max(p1Box.width, p1Box.height) * 1.7);
    players[2].avatar = cropSquareDataUrl(img, p2Box.originX + p2Box.width / 2, p2Box.originY + p2Box.height / 2, Math.max(p2Box.width, p2Box.height) * 1.7);

    if (drawBoxes) drawScanBoxes(ctx, [p1Box, p2Box]);

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

  $('btn-retake').addEventListener('click', () => enterCaptureScreen());
  $('scan-continue-btn').addEventListener('click', () => startPixelSequence());

  // ---------------------------------------------------------
  // Puzzle board
  // ---------------------------------------------------------
  let activeBoard = null;

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

  $('duel-manual-toggle').addEventListener('click', () => {
    if (!activeBoard) return;
    const on = activeBoard.el.classList.toggle('manual-off') === false;
    const btn = $('duel-manual-toggle');
    btn.classList.toggle('active', on);
    btn.textContent = on ? '🖱 Manual Mode: ON' : '🖱 Manual Mode';
  });

  function enableManualMode() {
    if (!activeBoard) return;
    activeBoard.el.classList.remove('manual-off');
    const btn = $('duel-manual-toggle');
    btn.classList.add('active');
    btn.textContent = '🖱 Manual Mode: ON';
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

  function startDuelTimer(playerId) {
    const t = timers[playerId];
    t.start = performance.now();
    t.finished = false;
    t.elapsed = 0;
    tickDuel(playerId);
  }

  function tickDuel(playerId) {
    const t = timers[playerId];
    if (t.finished) return;
    t.elapsed = performance.now() - t.start;
    $('duel-giant-timer').textContent = formatTime(t.elapsed);
    t.raf = requestAnimationFrame(() => tickDuel(playerId));
  }

  let duelResolve = null;

  function onPlayerSolved(playerId) {
    const t = timers[playerId];
    if (t.finished) return;
    t.finished = true;
    if (t.raf) cancelAnimationFrame(t.raf);
    $('duel-giant-timer').textContent = formatTime(t.elapsed);
    $('duel-winflag').classList.add('show');
    playWinFanfare();
    stopGestureTracking();
    setTimeout(() => {
      if (duelResolve) {
        const resolve = duelResolve;
        duelResolve = null;
        resolve();
      }
    }, 1300);
  }

  // ---------------------------------------------------------
  // Pixel arcade sequence: GAME START -> VS -> P1 turn -> P2 turn -> JUDGE
  // ---------------------------------------------------------
  async function startPixelSequence() {
    await showGameStart();
    await showVsScreen();
    await runPlayerTurn(1);
    await runPlayerTurn(2);
    await showJudge();
  }

  async function showGameStart() {
    showScreen('gamestart');
    restartAnimation($('gamestart-text'));
    playGameStartFanfare();
    await sleep(1600);
  }

  async function showVsScreen() {
    showScreen('vs');
    $('vs-avatar-1').style.backgroundImage = `url(${players[1].avatar})`;
    $('vs-avatar-2').style.backgroundImage = `url(${players[2].avatar})`;
    restartAnimation(document.querySelector('.vs-side-1'));
    restartAnimation(document.querySelector('.vs-side-2'));
    restartAnimation($('vs-text'));
    playVsSting();
    await sleep(2400);
  }

  async function runPlayerTurn(playerId) {
    await showTurnIntro(playerId);
    buildDuelBoard(playerId);
    $('duel-intro').hidden = true;
    await runDuelCountdown(playerId);
    $('duel-play').hidden = false;
    showScreen('duel');
    await new Promise((resolve) => {
      duelResolve = resolve;
      startDuelTimer(playerId);
      startGestureTracking();
    });
  }

  async function showTurnIntro(playerId) {
    showScreen('duel');
    $('duel-play').hidden = true;
    $('duel-intro').hidden = false;
    const hero = $('hero-avatar');
    hero.className = 'hero-avatar p' + playerId;
    hero.style.backgroundImage = `url(${players[playerId].avatar})`;
    restartAnimation(hero);
    $('duel-intro-text').textContent = `PLAYER ${playerId} GET READY!`;
    restartAnimation($('duel-intro-text'));
    playCountBeep();
    await sleep(1700);
  }

  function buildDuelBoard(playerId) {
    $('duel-hud-avatar').style.backgroundImage = `url(${players[playerId].avatar})`;
    $('duel-hud-name').textContent = 'PLAYER ' + playerId;
    $('duel-hud-name').className = playerId === 1 ? 'p1-color' : 'p2-color';
    $('duel-giant-timer').textContent = '00:00.0';
    $('duel-winflag').classList.remove('show');
    $('duel-manual-toggle').classList.remove('active');
    $('duel-manual-toggle').textContent = '🖱 Manual Mode';
    activeBoard = new PuzzleBoard($('duel-board'), playerId, groupPhotoDataUrl);
  }

  async function runDuelCountdown(playerId) {
    showScreen('countdown');
    $('countdown-player-label').textContent = 'PLAYER ' + playerId;
    const el = $('countdown-number');
    const seq = ['3', '2', '1', 'GO!'];
    for (const label of seq) {
      el.textContent = label;
      restartAnimation(el);
      el.style.animation = 'pop 0.5s ease-out';
      if (label === 'GO!') playGoBeep(); else playCountBeep();
      await sleep(700);
    }
  }

  // ---------------------------------------------------------
  // Judge screen: Roger the dog crowns the winner
  // ---------------------------------------------------------
  function setBubble(text) {
    const bubble = $('judge-bubble');
    bubble.style.opacity = '1';
    $('judge-bubble-text').textContent = text;
  }

  function resetJudgeVisualState() {
    [1, 2].forEach((p) => {
      $('judge-avatar-' + p).classList.remove('winner', 'loser');
      $('judge-crown-' + p).classList.remove('show');
    });
    document.querySelectorAll('.squash-dog').forEach((el) => el.classList.remove('show'));
    const dog = $('judge-dog');
    dog.style.opacity = '1';
    dog.classList.remove('bounce');
    $('judge-bubble').style.opacity = '0';
    $('btn-play-again').hidden = true;
  }

  async function showJudge() {
    showScreen('judge');
    resetJudgeVisualState();
    $('judge-avatar-1').style.backgroundImage = `url(${players[1].avatar})`;
    $('judge-avatar-2').style.backgroundImage = `url(${players[2].avatar})`;
    $('judge-time-1').textContent = formatTime(timers[1].elapsed);
    $('judge-time-2').textContent = formatTime(timers[2].elapsed);

    const dog = $('judge-dog');
    restartAnimation(dog);
    await sleep(650);
    dog.classList.add('bounce');

    setBubble("YOU BOTH DID GREAT...");
    await sleep(1400);
    setBubble('...BUT THERE CAN ONLY BE ONE WINNER!');
    await sleep(1600);
    $('judge-bubble').style.opacity = '0';

    const t1 = timers[1].elapsed, t2 = timers[2].elapsed;
    const winner = t1 === t2 ? (Math.random() < 0.5 ? 1 : 2) : (t1 < t2 ? 1 : 2);
    const loser = winner === 1 ? 2 : 1;

    $('judge-avatar-' + winner).classList.add('winner');
    $('judge-crown-' + winner).classList.add('show');
    $('judge-avatar-' + loser).classList.add('loser');
    playWinFanfare();
    await sleep(400);

    dog.classList.remove('bounce');
    dog.style.animation = 'none'; // release the dogHop fill-forwards lock so opacity below actually takes
    dog.style.opacity = '0';
    const squashDog = $('judge-avatar-' + loser).closest('.judge-avatar-slot').querySelector('.squash-dog');
    squashDog.classList.add('show');

    await sleep(900);
    $('btn-play-again').hidden = false;
  }

  $('btn-play-again').addEventListener('click', () => {
    stopGestureTracking();
    activeBoard = null;
    duelResolve = null;
    enterCaptureScreen();
  });

  // ---------------------------------------------------------
  // Gesture tracking (MediaPipe HandLandmarker) — single active
  // player's board, full camera frame maps directly to its grid.
  // ---------------------------------------------------------
  let handLandmarker = null;
  let handLoopActive = false;
  let gestureState = { lastCell: -1, dwellStart: 0, lastTrigger: 0, wasPinch: false };
  let lastPromptState = null;

  function setDuelPrompt(text, ok) {
    const el = $('duel-prompt');
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
      setDuelPrompt('⚠ NO CAMERA — USE 🖱 MANUAL MODE BELOW', false);
      enableManualMode();
      return;
    }

    try {
      handLandmarker = await getHandLandmarker();
    } catch (e) {
      console.warn('Gesture tracking unavailable, falling back to manual mode.', e);
      setDuelPrompt('⚠ GESTURE MODULE UNAVAILABLE — USE 🖱 MANUAL MODE BELOW', false);
      enableManualMode();
      return;
    }

    setDuelPrompt('✋ SHOW YOUR HAND — HOVER (0.7s) OR PINCH A TILE TO SWAP', true);
    handLoopActive = true;
    lastPromptState = null;
    gestureState = { lastCell: -1, dwellStart: 0, lastTrigger: 0, wasPinch: false };
    const cursor = $('duel-cursor');
    cursor.classList.remove('p2');
    if (activeBoard && activeBoard.playerId === 2) cursor.classList.add('p2');
    requestAnimationFrame(predictLoop);
  }

  function stopGestureTracking() {
    handLoopActive = false;
    hideCursor();
  }

  function predictLoop() {
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

    if (landmarks.length === 0) {
      hideCursor();
      gestureState.dwellStart = 0;
      gestureState.lastCell = -1;
      gestureState.wasPinch = false;
      setDuelPrompt('⚠ SHOW YOUR HAND TO THE CAMERA', false);
      return;
    }

    const lm = landmarks[0];
    const indexTip = lm[8];
    const thumbTip = lm[4];
    const mx = clamp01(1 - indexTip.x); // mirror to match displayed (selfie) view
    const my = clamp01(indexTip.y);
    updateCursor(mx, my);

    const dist = Math.hypot(
      indexTip.x - thumbTip.x,
      indexTip.y - thumbTip.y,
      (indexTip.z || 0) - (thumbTip.z || 0)
    );
    const pinching = dist < CONFIG.PINCH_DIST;
    setPinchVisual(pinching);
    handleHover(mx, my, pinching, now);
    setDuelPrompt('✋ TRACKING HAND — HOVER OR PINCH TO SWAP', true);
  }

  function handleHover(lx, ly, pinching, now) {
    const board = activeBoard;
    const st = gestureState;
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

  function updateCursor(lx, ly) {
    const el = $('duel-cursor');
    el.style.display = (lx < 0 || lx > 1 || ly < 0 || ly > 1) ? 'none' : 'block';
    el.style.left = `${clamp01(lx) * 100}%`;
    el.style.top = `${clamp01(ly) * 100}%`;
  }
  function hideCursor() { $('duel-cursor').style.display = 'none'; }
  function setPinchVisual(pinching) { $('duel-cursor').classList.toggle('pinch', pinching); }

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
    (result.landmarks || []).forEach((lm) => {
      const color = activeBoard && activeBoard.playerId === 2 ? '#ff5fd1' : '#35c3ff';
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
    captureLoopActive = false;
    duelResolve = null;
    activeBoard = null;
    lastHandAnchors = null;
    Object.values(timers).forEach((t) => { if (t.raf) cancelAnimationFrame(t.raf); t.finished = true; });
    stopCamera();
    groupPhotoDataUrl = null;
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
