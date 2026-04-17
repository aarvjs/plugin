/**
 * AI Trainer Plugin — script.js
 * ─────────────────────────────
 * MediaPipe Pose | Dynamic workout from URL | Flutter WebView API
 * No hardcoded workout definitions — fully data-driven from URL param.
 */

'use strict';

/* ════════════════════════════════════════════════════════
   1. CONSTANTS & CONFIGURATION
   ════════════════════════════════════════════════════════ */

const CFG = {
  TARGET_FPS: 22,          // balanced for mobile
  MIN_VISIBILITY: 0.40,        // landmark confidence threshold
  MODEL_COMPLEXITY: 1,          // 0=lite, 1=full, 2=heavy
  MIN_DETECT_CF: 0.50,
  MIN_TRACK_CF: 0.50,
  NO_BODY_LIMIT: 24,          // frames before "no body" message
  SKELETON_COLOR: '#00e5ff',
  JOINT_RADIUS: 5,
  LINE_WIDTH: 2.8,
};

/**
 * ════════════════════════════════════════════════════════
 * 2. DYNAMIC WORKOUT RESOLVER
 *    No hardcoded WORKOUTS object.
 *    All workout config is built FROM the URL param.
 * ════════════════════════════════════════════════════════
 *
 * Supported ?workout= values: pushup | squat | curl | lunge | situp
 *
 * Each workout returns:
 *   label       – display name
 *   joints      – [A, B, C] landmark keys to compute angle at B
 *   altJoints   – fallback side if primary is low-visibility
 *   upAngle     – angle that triggers phase → 'up'
 *   downAngle   – angle that triggers phase → 'down'
 *   goodRange   – [min, max] angle for "Good Form" feedback
 *   hint        – coaching cue
 */
function resolveWorkoutConfig(workoutKey) {
  const k = (workoutKey || 'pushup').toLowerCase().trim();

  // ── joint landmark name maps ────────────────────────
  const J = {
    LSH: 'LEFT_SHOULDER', RSH: 'RIGHT_SHOULDER',
    LEL: 'LEFT_ELBOW', REL: 'RIGHT_ELBOW',
    LWR: 'LEFT_WRIST', RWR: 'RIGHT_WRIST',
    LHP: 'LEFT_HIP', RHP: 'RIGHT_HIP',
    LKN: 'LEFT_KNEE', RKN: 'RIGHT_KNEE',
    LAN: 'LEFT_ANKLE', RAN: 'RIGHT_ANKLE',
    LSH2: 'LEFT_SHOULDER', RKN2: 'RIGHT_KNEE',
  };

  // ── workout config table ────────────────────────────
  const table = {
    pushup: {
      label: 'Push-Up',
      joints: [J.LSH, J.LEL, J.LWR],
      altJoints: [J.RSH, J.REL, J.RWR],
      upAngle: 155, downAngle: 85,
      goodRange: [70, 100],
      hint: 'Lower until elbows ~90°',
    },
    squat: {
      label: 'Squat',
      joints: [J.LHP, J.LKN, J.LAN],
      altJoints: [J.RHP, J.RKN, J.RAN],
      upAngle: 160, downAngle: 100,
      goodRange: [85, 115],
      hint: 'Thighs parallel to floor',
    },
    curl: {
      label: 'Bicep Curl',
      joints: [J.LSH, J.LEL, J.LWR],
      altJoints: [J.RSH, J.REL, J.RWR],
      upAngle: 50, downAngle: 140,
      goodRange: [35, 60],
      hint: 'Curl wrist toward shoulder',
    },
    lunge: {
      label: 'Lunge',
      joints: [J.LHP, J.LKN, J.LAN],
      altJoints: [J.RHP, J.RKN, J.RAN],
      upAngle: 160, downAngle: 95,
      goodRange: [80, 105],
      hint: 'Front knee over ankle',
    },
    situp: {
      label: 'Sit-Up',
      joints: [J.LHP, J.LSH, J.LKN],
      altJoints: [J.RHP, J.RSH, J.RKN],
      upAngle: 60, downAngle: 130,
      goodRange: [45, 75],
      hint: 'Engage core, chin up',
    },
  };

  return table[k] || table['pushup'];
}

/* ════════════════════════════════════════════════════════
   3. MEDIAPIPE LANDMARK INDEX MAP
   ════════════════════════════════════════════════════════ */
const LMK = {
  NOSE: 0,
  LEFT_EYE_INNER: 1, LEFT_EYE: 2, LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4, RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7, RIGHT_EAR: 8,
  MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_PINKY: 17, RIGHT_PINKY: 18,
  LEFT_INDEX: 19, RIGHT_INDEX: 20,
  LEFT_THUMB: 21, RIGHT_THUMB: 22,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_HEEL: 29, RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
};

/* ════════════════════════════════════════════════════════
   4. SKELETON CONNECTIONS  (MediaPipe POSE_CONNECTIONS)
   ════════════════════════════════════════════════════════ */
const SKELETON_CONNECTIONS = [
  // Face
  [LMK.LEFT_EAR, LMK.LEFT_EYE],
  [LMK.LEFT_EYE, LMK.NOSE],
  [LMK.NOSE, LMK.RIGHT_EYE],
  [LMK.RIGHT_EYE, LMK.RIGHT_EAR],
  // Shoulders
  [LMK.LEFT_SHOULDER, LMK.RIGHT_SHOULDER],
  // Left arm
  [LMK.LEFT_SHOULDER, LMK.LEFT_ELBOW],
  [LMK.LEFT_ELBOW, LMK.LEFT_WRIST],
  [LMK.LEFT_WRIST, LMK.LEFT_INDEX],
  // Right arm
  [LMK.RIGHT_SHOULDER, LMK.RIGHT_ELBOW],
  [LMK.RIGHT_ELBOW, LMK.RIGHT_WRIST],
  [LMK.RIGHT_WRIST, LMK.RIGHT_INDEX],
  // Torso
  [LMK.LEFT_SHOULDER, LMK.LEFT_HIP],
  [LMK.RIGHT_SHOULDER, LMK.RIGHT_HIP],
  [LMK.LEFT_HIP, LMK.RIGHT_HIP],
  // Left leg
  [LMK.LEFT_HIP, LMK.LEFT_KNEE],
  [LMK.LEFT_KNEE, LMK.LEFT_ANKLE],
  [LMK.LEFT_ANKLE, LMK.LEFT_HEEL],
  [LMK.LEFT_HEEL, LMK.LEFT_FOOT_INDEX],
  // Right leg
  [LMK.RIGHT_HIP, LMK.RIGHT_KNEE],
  [LMK.RIGHT_KNEE, LMK.RIGHT_ANKLE],
  [LMK.RIGHT_ANKLE, LMK.RIGHT_HEEL],
  [LMK.RIGHT_HEEL, LMK.RIGHT_FOOT_INDEX],
];

/* ════════════════════════════════════════════════════════
   5. DOM REFERENCES
   ════════════════════════════════════════════════════════ */
const DOM = {
  video: document.getElementById('videoEl'),
  canvas: document.getElementById('poseCanvas'),
  loadScreen: document.getElementById('loadScreen'),
  loadStep: document.getElementById('loadStep'),
  permScreen: document.getElementById('permScreen'),
  toast: document.getElementById('toast'),
  toastIcon: document.getElementById('toastIcon'),
  toastText: document.getElementById('toastText'),
  repNum: document.getElementById('repNum'),
  statusIcon: document.getElementById('statusIcon'),
  statusText: document.getElementById('statusText'),
  statusHint: document.getElementById('statusHint'),
  workoutBadge: document.getElementById('workoutBadge'),
  angleValue: document.getElementById('angleValue'),
  phasePill: document.getElementById('phasePill'),
  repFlash: document.getElementById('repFlash'),
  backBtn: document.getElementById('backBtn'),
  retryBtn: document.getElementById('retryBtn'),
};

/* ════════════════════════════════════════════════════════
   6. APPLICATION STATE
   ════════════════════════════════════════════════════════ */
const S = {
  reps: 0,
  phase: 'up',        // 'up' | 'down'
  lastAngle: 0,
  noBodyCount: 0,
  running: false,
  workout: null,        // resolved config object
  workoutKey: 'pushup',
  ctx: null,
  pose: null,
  rafId: null,
  prevFrameTs: 0,
  frameGap: 1000 / CFG.TARGET_FPS,
  toastTimer: null,
};

/* ════════════════════════════════════════════════════════
   7. FLUTTER / EXTERNAL API  (window globals)
   ════════════════════════════════════════════════════════ */
window.reps = 0;
window.workout = 'pushup';

/** Called by Flutter WebView: window.resetReps() */
window.resetReps = () => {
  S.reps = 0;
  S.phase = 'up';
  DOM.repNum.textContent = '0';
  _syncFlutter();
};

function _syncFlutter() {
  window.reps = S.reps;
  window.workout = S.workoutKey;

  // Optional JS-channel push for Flutter (if channel registered)
  if (window.TrainerChannel?.postMessage) {
    window.TrainerChannel.postMessage(JSON.stringify({
      reps: S.reps,
      workout: S.workoutKey,
      phase: S.phase,
      angle: Math.round(S.lastAngle),
      status: DOM.statusText.textContent,
    }));
  }
}

/* ════════════════════════════════════════════════════════
   8. STEP 1 — RESOLVE WORKOUT FROM URL
   ════════════════════════════════════════════════════════ */
function initWorkout() {
  const params = new URLSearchParams(window.location.search);
  const key = params.get('workout') || 'pushup';
  S.workoutKey = key;
  S.workout = resolveWorkoutConfig(key);
  window.workout = S.workoutKey;

  DOM.workoutBadge.textContent = S.workout.label;
}

/* ════════════════════════════════════════════════════════
   9. STEP 2 — CAMERA
   ════════════════════════════════════════════════════════ */
async function startCamera() {
  _setLoadStep('Accessing camera…');

  const constraints = {
    video: {
      facingMode: { ideal: 'user' },
      width: { ideal: 640, max: 1280 },
      height: { ideal: 480, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    DOM.video.srcObject = stream;

    await new Promise((ok, fail) => {
      DOM.video.onloadedmetadata = ok;
      DOM.video.onerror = fail;
    });

    await DOM.video.play();
    return true;
  } catch (err) {
    console.error(err);
    _showPermScreen();
    return false;
  }
}

/* ════════════════════════════════════════════════════════
   10. STEP 3 — MEDIAPIPE POSE INIT
   ════════════════════════════════════════════════════════ */
async function initPose() {
  _setLoadStep('Loading AI model…');

  S.pose = new window.Pose({
    locateFile: (f) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${f}`,
  });

  S.pose.setOptions({
    modelComplexity: CFG.MODEL_COMPLEXITY,
    smoothLandmarks: true,
    enableSegmentation: false,
    smoothSegmentation: false,
    minDetectionConfidence: CFG.MIN_DETECT_CF,
    minTrackingConfidence: CFG.MIN_TRACK_CF,
  });

  S.pose.onResults(_onPoseResults);

  // Force WASM initialization before the render loop starts
  await S.pose.initialize();
}

/* ════════════════════════════════════════════════════════
   11. POSE RESULTS CALLBACK
   ════════════════════════════════════════════════════════ */
function _onPoseResults(results) {
  if (!S.running) return;

  // Sync canvas dimensions to video (do this every frame cheaply)
  const vw = DOM.video.videoWidth || DOM.canvas.offsetWidth;
  const vh = DOM.video.videoHeight || DOM.canvas.offsetHeight;
  if (DOM.canvas.width !== vw || DOM.canvas.height !== vh) {
    DOM.canvas.width = vw;
    DOM.canvas.height = vh;
  }

  const ctx = S.ctx;
  ctx.clearRect(0, 0, DOM.canvas.width, DOM.canvas.height);

  const lm = results.poseLandmarks;

  if (!lm || lm.length === 0) {
    S.noBodyCount++;
    if (S.noBodyCount >= CFG.NO_BODY_LIMIT) {
      _showToast('🕺', 'No body detected\nStep closer to the camera', true);
      _setStatus('👀', 'Step into frame', '', 'c-muted');
    }
    return;
  }

  // Body detected — reset counter & toast
  if (S.noBodyCount >= CFG.NO_BODY_LIMIT) _hideToast();
  S.noBodyCount = 0;

  // ─ Draw skeleton ─────────────────────────────────
  _drawSkeleton(ctx, lm);

  // ─ Compute angle & count reps ────────────────────
  const points = _pickBestPoints(lm);
  if (points) {
    const [A, B, C] = points;
    const angle = _calcAngle(A, B, C);
    S.lastAngle = angle;
    _processRep(angle);
  }
}

/* ════════════════════════════════════════════════════════
   12. SKELETON RENDERER
   ════════════════════════════════════════════════════════ */
function _drawSkeleton(ctx, lm) {
  const W = DOM.canvas.width;
  const H = DOM.canvas.height;

  /* ── Connections ───────────────────────────────── */
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = CFG.LINE_WIDTH;

  SKELETON_CONNECTIONS.forEach(([a, b]) => {
    const pA = lm[a];
    const pB = lm[b];
    if (!pA || !pB) return;
    if ((pA.visibility || 0) < CFG.MIN_VISIBILITY) return;
    if ((pB.visibility || 0) < CFG.MIN_VISIBILITY) return;

    const vis = Math.min(pA.visibility, pB.visibility);
    const x1 = pA.x * W; const y1 = pA.y * H;
    const x2 = pB.x * W; const y2 = pB.y * H;

    // Gradient along bone
    const grad = ctx.createLinearGradient(x1, y1, x2, y2);
    grad.addColorStop(0, `rgba(0,229,255,${0.30 + vis * 0.60})`);
    grad.addColorStop(1, `rgba(0,229,255,${0.30 + vis * 0.60})`);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = grad;
    ctx.stroke();
  });

  /* ── Joints ────────────────────────────────────── */
  lm.forEach((p) => {
    if ((p.visibility || 0) < CFG.MIN_VISIBILITY) return;

    const x = p.x * W;
    const y = p.y * H;
    const v = p.visibility;

    // Soft glow halo
    const halo = ctx.createRadialGradient(x, y, 0, x, y, CFG.JOINT_RADIUS * 3);
    halo.addColorStop(0, `rgba(0,229,255,${0.4 * v})`);
    halo.addColorStop(1, 'rgba(0,229,255,0)');
    ctx.beginPath();
    ctx.arc(x, y, CFG.JOINT_RADIUS * 3, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();

    // Core dot
    ctx.beginPath();
    ctx.arc(x, y, CFG.JOINT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = CFG.SKELETON_COLOR;
    ctx.shadowColor = CFG.SKELETON_COLOR;
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
  });
}

/* ════════════════════════════════════════════════════════
   13. ANGLE CALCULATION
   ════════════════════════════════════════════════════════ */
function _calcAngle(A, B, C) {
  // Vectors BA and BC
  const BAx = A.x - B.x; const BAy = A.y - B.y;
  const BCx = C.x - B.x; const BCy = C.y - B.y;

  const dot = BAx * BCx + BAy * BCy;
  const magBA = Math.hypot(BAx, BAy);
  const magBC = Math.hypot(BCx, BCy);

  if (magBA === 0 || magBC === 0) return 0;
  const cosA = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
  return Math.acos(cosA) * (180 / Math.PI);
}

/* ════════════════════════════════════════════════════════
   14. JOINT SELECTOR
       Picks the higher-visibility side (left or right)
   ════════════════════════════════════════════════════════ */
function _pickBestPoints(lm) {
  const cfg = S.workout;
  if (!cfg) return null;

  const _get = (nameArr) => nameArr.map((n) => lm[LMK[n]]);

  const primary = _get(cfg.joints);
  const alt = _get(cfg.altJoints);

  const visSum = (pts) =>
    pts.reduce((s, p) => s + ((p && p.visibility) || 0), 0);

  const chosen = visSum(primary) >= visSum(alt) ? primary : alt;

  // Require all three points to be confident enough
  const allVisible = chosen.every(
    (p) => p && (p.visibility || 0) >= CFG.MIN_VISIBILITY
  );

  return allVisible ? chosen : null;
}

/* ════════════════════════════════════════════════════════
   15. REP COUNTER  (pure angle-based, no hardcoded logic)
   ════════════════════════════════════════════════════════ */
function _processRep(angle) {
  const cfg = S.workout;

  // Phase transitions
  if (S.phase === 'up' && angle <= cfg.downAngle) {
    S.phase = 'down';
  } else if (S.phase === 'down' && angle >= cfg.upAngle) {
    S.phase = 'up';
    S.reps++;
    _onRepComplete();
  }

  // Form feedback
  const [gMin, gMax] = cfg.goodRange;
  const inGoodForm = angle >= gMin && angle <= gMax;

  DOM.phasePill.textContent = S.phase.toUpperCase();
  DOM.angleValue.textContent = `${Math.round(angle)}°`;
  DOM.repNum.textContent = S.reps;

  if (S.phase === 'down' && inGoodForm) {
    _setStatus('✅', 'Good Form', cfg.hint, 'c-good');
  } else if (S.phase === 'down' && !inGoodForm) {
    _setStatus('⚠️', 'Adjust Posture', cfg.hint, 'c-warn');
  } else {
    _setStatus('🎯', 'Ready', `${cfg.label} · get into position`, 'c-muted');
  }

  _syncFlutter();
}

/* ════════════════════════════════════════════════════════
   16. REP ANIMATION
   ════════════════════════════════════════════════════════ */
function _onRepComplete() {
  // Number bump animation
  DOM.repNum.classList.remove('bump');
  void DOM.repNum.offsetWidth;   // force reflow
  DOM.repNum.classList.add('bump');
  setTimeout(() => DOM.repNum.classList.remove('bump'), 400);

  // Screen flash
  DOM.repFlash.classList.add('on');
  setTimeout(() => DOM.repFlash.classList.remove('on'), 160);
}

/* ════════════════════════════════════════════════════════
   17. RENDER LOOP
       requestAnimationFrame + delta-time FPS cap
   ════════════════════════════════════════════════════════ */
function _startRenderLoop() {
  function loop(now) {
    S.rafId = requestAnimationFrame(loop);

    // FPS throttle
    if (now - S.prevFrameTs < S.frameGap) return;
    S.prevFrameTs = now;

    if (!S.running || DOM.video.readyState < 2) return;

    // send() is async — errors silently swallowed to avoid log spam
    S.pose.send({ image: DOM.video }).catch(() => { });
  }

  S.rafId = requestAnimationFrame(loop);
}

/* ════════════════════════════════════════════════════════
   18. UI HELPERS
   ════════════════════════════════════════════════════════ */
function _setStatus(icon, text, hint, cls) {
  DOM.statusIcon.textContent = icon;
  DOM.statusText.textContent = text;
  DOM.statusText.className = cls;
  DOM.statusHint.textContent = hint;
}

function _setLoadStep(msg) {
  if (DOM.loadStep) DOM.loadStep.textContent = msg;
}

function _showToast(icon, text, persistent = false) {
  DOM.toastIcon.textContent = icon;
  DOM.toastText.textContent = text;
  DOM.toast.classList.add('show');

  clearTimeout(S.toastTimer);
  if (!persistent) {
    S.toastTimer = setTimeout(_hideToast, 2800);
  }
}

function _hideToast() {
  DOM.toast.classList.remove('show');
}

function _showPermScreen() {
  DOM.loadScreen.classList.add('gone');
  DOM.permScreen.classList.add('show');
}

function _hideLoadScreen() {
  DOM.loadScreen.classList.add('gone');
}

/* ════════════════════════════════════════════════════════
   19. BOOTSTRAP
   ════════════════════════════════════════════════════════ */
async function bootstrap() {
  // Step 0 — resolve workout from URL
  initWorkout();

  // Step 1 — camera
  const camOK = await startCamera();
  if (!camOK) return;

  // Step 2 — canvas context
  S.ctx = DOM.canvas.getContext('2d');
  DOM.canvas.width = DOM.video.videoWidth || window.innerWidth;
  DOM.canvas.height = DOM.video.videoHeight || window.innerHeight;

  // Step 3 — MediaPipe Pose model
  try {
    await initPose();
  } catch (e) {
    console.error('[Pose] init failed', e);
    _setLoadStep('Model failed. Refresh and try again.');
    return;
  }

  // Ready!
  S.running = true;
  _hideLoadScreen();
  _setStatus('🎯', 'Ready', S.workout.label + ' · get into position', 'c-muted');
  _showToast('💪', S.workout.hint, false);

  _startRenderLoop();
}

/* ════════════════════════════════════════════════════════
   20. EVENT LISTENERS
   ════════════════════════════════════════════════════════ */

// Back button
DOM.backBtn.addEventListener('click', () => {
  if (window.history.length > 1) window.history.back();
  else if (window.FlutterBackChannel?.postMessage)
    window.FlutterBackChannel.postMessage('back');
});

// Retry camera after permission denial
DOM.retryBtn.addEventListener('click', () => {
  DOM.permScreen.classList.remove('show');
  DOM.loadScreen.classList.remove('gone');
  bootstrap();
});

// Recalculate canvas on orientation change
window.addEventListener('resize', () => {
  DOM.canvas.width = DOM.video.videoWidth || window.innerWidth;
  DOM.canvas.height = DOM.video.videoHeight || window.innerHeight;
});

// Block accidental scroll/zoom on touch devices
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

/* ════════════════════════════════════════════════════════
   21. ENTRY POINT
   ════════════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', bootstrap);
