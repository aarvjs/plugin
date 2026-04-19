/* ═══════════════════════════════════════════════════════════
   FITLIX AI TRAINER — script.js
   MediaPipe Pose | Real-time Rep Counting | Flutter Bridge
═══════════════════════════════════════════════════════════ */

'use strict';

/* ──────────────────────────────────────────────
   0. CONSTANTS & GLOBAL STATE
────────────────────────────────────────────── */
const CONFIDENCE_THRESHOLD = 0.60;
const MIN_REP_DURATION_MS = 800;       // anti-cheat: ignore reps faster than 0.8s
const ANGLE_SMOOTH_WINDOW = 5;         // moving-average window for angles
const FEEDBACK_THROTTLE_MS = 1200;      // how often to update feedback toast

const WorkoutMeta = {
  pushup: { name: 'Push-Up', icon: '💪', joints: ['elbow', 'body'], primary: 'elbow' },
  squat: { name: 'Squat', icon: '🏋️', joints: ['knee', 'hip'], primary: 'knee' },
  pullup: { name: 'Pull-Up', icon: '🦾', joints: ['elbow', 'body'], primary: 'elbow' },
  lunge: { name: 'Lunge', icon: '🦵', joints: ['knee'], primary: 'knee' },
  situp: { name: 'Sit-Up', icon: '🔥', joints: ['hip'], primary: 'hip' },
  bicep_curl: { name: 'Bicep Curl', icon: '💪', joints: ['elbow'], primary: 'elbow' },
  shoulder_press: { name: 'Shoulder Press', icon: '🏋️', joints: ['elbow'], primary: 'elbow' },
  jumping_jack: { name: 'Jumping Jacks', icon: '⚡', joints: ['arm_spread'], primary: 'arm_spread' },
};

// Workout-specific thresholds: [downAngle, upAngle]
const WorkoutThresholds = {
  pushup: { down: 90, up: 160, downLabel: 'Go Lower', upLabel: 'Push Up' },
  squat: { down: 90, up: 160, downLabel: 'Go Deeper', upLabel: 'Stand Up' },
  pullup: { down: 160, up: 60, downLabel: 'Go Lower', upLabel: 'Pull Up' },
  lunge: { down: 90, up: 160, downLabel: 'Go Deeper', upLabel: 'Stand Up' },
  situp: { down: 60, up: 120, downLabel: 'Go Down', upLabel: 'Sit Up' },
  bicep_curl: { down: 160, up: 50, downLabel: 'Lower Arm', upLabel: 'Curl Up' },
  shoulder_press: { down: 90, up: 160, downLabel: 'Go Lower', upLabel: 'Press Up' },
  jumping_jack: { down: 20, up: 80, downLabel: 'Arms Out', upLabel: 'Arms Down' },
};

// Canonical landmark indices from MediaPipe Pose
const LM = {
  NOSE: 0, L_EYE_I: 1, L_EYE: 2, L_EYE_O: 3,
  R_EYE_I: 4, R_EYE: 5, R_EYE_O: 6,
  L_EAR: 7, R_EAR: 8,
  MOUTH_L: 9, MOUTH_R: 10,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_PINKY: 17, R_PINKY: 18,
  L_INDEX: 19, R_INDEX: 20,
  L_THUMB: 21, R_THUMB: 22,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_FOOT_I: 31, R_FOOT_I: 32,
};

/* ──────────────────────────────────────────────
   1. URL PARAMS & WORKOUT SETUP
────────────────────────────────────────────── */
const urlParams = new URLSearchParams(window.location.search);
const workoutKey = (urlParams.get('workout') || 'pushup').toLowerCase().replace('-', '_');
const meta = WorkoutMeta[workoutKey] || WorkoutMeta.pushup;
const thresholds = WorkoutThresholds[workoutKey] || WorkoutThresholds.pushup;

document.getElementById('workout-name').textContent = meta.name;
document.getElementById('workout-icon').textContent = meta.icon;

/* ──────────────────────────────────────────────
   2. DOM REFERENCES
────────────────────────────────────────────── */
const videoEl = document.getElementById('input-video');
const canvasEl = document.getElementById('pose-canvas');
const ctx = canvasEl.getContext('2d');
const frameAlertEl = document.getElementById('frame-alert');
const feedbackEl = document.getElementById('feedback-toast');
const statRepsEl = document.getElementById('stat-reps');
const topRepsEl = document.getElementById('top-reps');
const statAngleEl = document.getElementById('stat-angle');
const statStatusEl = document.getElementById('stat-status');
const statusDotEl = document.getElementById('status-dot');
const loaderBar = document.getElementById('loader-bar');

/* ──────────────────────────────────────────────
   3. REP STATE MACHINE
────────────────────────────────────────────── */
let currentReps = 0;
let repPhase = 'UP';      // 'UP' | 'DOWN'
let lastRepTime = 0;
let lastFeedbackTime = 0;

// Expose to Flutter
window.reps = 0;

/* Angle moving-average buffers */
const angleBuffers = {};

function smoothAngle(key, raw) {
  if (!angleBuffers[key]) angleBuffers[key] = [];
  const buf = angleBuffers[key];
  buf.push(raw);
  if (buf.length > ANGLE_SMOOTH_WINDOW) buf.shift();
  return buf.reduce((a, b) => a + b, 0) / buf.length;
}

/* ──────────────────────────────────────────────
   4. MATH HELPERS
────────────────────────────────────────────── */
function angleBetween(A, B, C) {
  // Angle at vertex B formed by segments BA and BC
  const radians = Math.atan2(C.y - B.y, C.x - B.x)
    - Math.atan2(A.y - B.y, A.x - B.x);
  let deg = Math.abs(radians * (180 / Math.PI));
  if (deg > 180) deg = 360 - deg;
  return deg;
}

function midpoint(A, B) {
  return { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, visibility: Math.min(A.visibility, B.visibility) };
}

function isVisible(lm, idx, threshold = CONFIDENCE_THRESHOLD) {
  return lm && lm[idx] && lm[idx].visibility >= threshold;
}

function allVisible(lm, indices, threshold = CONFIDENCE_THRESHOLD) {
  return indices.every(i => isVisible(lm, i, threshold));
}

/* Body straightness check: shoulder-hip-ankle deviation */
function isBodyStraight(lm) {
  const sides = [
    [LM.L_SHOULDER, LM.L_HIP, LM.L_ANKLE],
    [LM.R_SHOULDER, LM.R_HIP, LM.R_ANKLE],
  ];
  for (const [s, h, a] of sides) {
    if (!allVisible(lm, [s, h, a], 0.5)) continue;
    const angle = angleBetween(lm[s], lm[h], lm[a]);
    if (angle < 155) return false; // hip bent too much
  }
  return true;
}

/* ──────────────────────────────────────────────
   5. WORKOUT-SPECIFIC ANGLE EXTRACTORS
────────────────────────────────────────────── */
function getPrimaryAngle(lm) {
  switch (workoutKey) {

    case 'pushup':
    case 'pullup': {
      // Average both elbows; fall back to one side if other not visible
      const la = allVisible(lm, [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST])
        ? angleBetween(lm[LM.L_SHOULDER], lm[LM.L_ELBOW], lm[LM.L_WRIST]) : null;
      const ra = allVisible(lm, [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST])
        ? angleBetween(lm[LM.R_SHOULDER], lm[LM.R_ELBOW], lm[LM.R_WRIST]) : null;
      if (la !== null && ra !== null) return (la + ra) / 2;
      return la ?? ra ?? null;
    }

    case 'bicep_curl':
    case 'shoulder_press': {
      const la = allVisible(lm, [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST])
        ? angleBetween(lm[LM.L_SHOULDER], lm[LM.L_ELBOW], lm[LM.L_WRIST]) : null;
      const ra = allVisible(lm, [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST])
        ? angleBetween(lm[LM.R_SHOULDER], lm[LM.R_ELBOW], lm[LM.R_WRIST]) : null;
      if (la !== null && ra !== null) return (la + ra) / 2;
      return la ?? ra ?? null;
    }

    case 'squat':
    case 'lunge': {
      const la = allVisible(lm, [LM.L_HIP, LM.L_KNEE, LM.L_ANKLE])
        ? angleBetween(lm[LM.L_HIP], lm[LM.L_KNEE], lm[LM.L_ANKLE]) : null;
      const ra = allVisible(lm, [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE])
        ? angleBetween(lm[LM.R_HIP], lm[LM.R_KNEE], lm[LM.R_ANKLE]) : null;
      if (la !== null && ra !== null) return (la + ra) / 2;
      return la ?? ra ?? null;
    }

    case 'situp': {
      const la = allVisible(lm, [LM.L_SHOULDER, LM.L_HIP, LM.L_KNEE])
        ? angleBetween(lm[LM.L_SHOULDER], lm[LM.L_HIP], lm[LM.L_KNEE]) : null;
      const ra = allVisible(lm, [LM.R_SHOULDER, LM.R_HIP, LM.R_KNEE])
        ? angleBetween(lm[LM.R_SHOULDER], lm[LM.R_HIP], lm[LM.R_KNEE]) : null;
      if (la !== null && ra !== null) return (la + ra) / 2;
      return la ?? ra ?? null;
    }

    case 'jumping_jack': {
      // Use arm spread angle at shoulder
      if (!allVisible(lm, [LM.L_ELBOW, LM.L_SHOULDER, LM.R_SHOULDER])) return null;
      return angleBetween(lm[LM.L_ELBOW], lm[LM.L_SHOULDER], lm[LM.R_SHOULDER]);
    }

    default:
      return null;
  }
}

/* ──────────────────────────────────────────────
   6. REP COUNTING LOGIC
────────────────────────────────────────────── */
function processRep(rawAngle) {
  const angle = smoothAngle('primary', rawAngle);
  const now = Date.now();
  const { down, up } = thresholds;

  // Determine "down" vs "up" direction based on workout type
  // For pull-up, bicep_curl: down means LARGER angle; up means SMALLER
  const invertedWorkouts = ['pullup', 'bicep_curl'];
  const inverted = invertedWorkouts.includes(workoutKey);

  const isDown = inverted ? (angle >= down) : (angle <= down);
  const isUp = inverted ? (angle <= up) : (angle >= up);

  if (repPhase === 'UP' && isDown) {
    repPhase = 'DOWN';
  } else if (repPhase === 'DOWN' && isUp) {
    const elapsed = now - lastRepTime;
    if (elapsed >= MIN_REP_DURATION_MS) {
      currentReps++;
      window.reps = currentReps;
      lastRepTime = now;
      repPhase = 'UP';
      return { counted: true, angle };
    }
  }
  return { counted: false, angle };
}

/* ──────────────────────────────────────────────
   7. FEEDBACK LOGIC
────────────────────────────────────────────── */
function getFeedback(angle, poseOk) {
  if (!poseOk) return { msg: 'Straighten Body', cls: 'bad' };

  const { down, up } = thresholds;
  const invertedWorkouts = ['pullup', 'bicep_curl'];
  const inverted = invertedWorkouts.includes(workoutKey);

  if (repPhase === 'UP') {
    // Expect the user to go down
    const halfwayDown = inverted
      ? (angle >= (up + (down - up) * 0.45))
      : (angle <= (up - (up - down) * 0.45));
    if (halfwayDown) return { msg: thresholds.downLabel, cls: 'warn' };
    return { msg: 'Good Form', cls: 'good' };
  } else {
    // User is in DOWN phase — expect them to push up
    return { msg: thresholds.upLabel, cls: 'warn' };
  }
}

/* ──────────────────────────────────────────────
   8. VOICE FEEDBACK
────────────────────────────────────────────── */
const synth = window.speechSynthesis;
let isSpeaking = false;

function speakRep(count) {
  if (!synth || isSpeaking) return;
  // Avoid speaking during movement; don't queue
  const utterance = new SpeechSynthesisUtterance(String(count));
  utterance.rate = 1.1;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;
  utterance.onstart = () => { isSpeaking = true; };
  utterance.onend = () => { isSpeaking = false; };
  synth.cancel();
  synth.speak(utterance);
}

/* ──────────────────────────────────────────────
   9. UI UPDATERS
────────────────────────────────────────────── */
function updateRepUI(animated = false) {
  statRepsEl.textContent = currentReps;
  topRepsEl.textContent = currentReps;
  if (animated) {
    statRepsEl.classList.remove('rep-flash');
    void statRepsEl.offsetWidth; // reflow
    statRepsEl.classList.add('rep-flash');
    topRepsEl.classList.remove('rep-flash');
    void topRepsEl.offsetWidth;
    topRepsEl.classList.add('rep-flash');
  }
}

function updateAngleUI(angle, isGood) {
  statAngleEl.textContent = angle !== null ? `${Math.round(angle)}°` : '—°';
  statAngleEl.className = 'stat-value ' + (isGood ? 'good' : 'bad');
}

function setStatus(label, color) {
  statStatusEl.textContent = label;
  statusDotEl.className = `status-indicator ${color}`;
}

function showFeedbackToast(msg, cls) {
  feedbackEl.textContent = msg;
  feedbackEl.className = `feedback-toast ${cls}`;
  feedbackEl.classList.remove('hidden');
}

function showFrameAlert(visible) {
  frameAlertEl.classList.toggle('hidden', !visible);
}

/* ──────────────────────────────────────────────
   10. FLUTTER BRIDGE
────────────────────────────────────────────── */
function sendToFlutter(reps) {
  try {
    if (window.flutter_inappwebview) {
      window.flutter_inappwebview.callHandler('flutterBridge', { reps });
    }
  } catch (_) { }
}

/* ──────────────────────────────────────────────
   11. SKELETON DRAWING
────────────────────────────────────────────── */
// MediaPipe Pose connections (subset — full body)
const POSE_CONNECTIONS = [
  // Face
  [LM.NOSE, LM.L_EYE_I], [LM.L_EYE_I, LM.L_EYE], [LM.L_EYE, LM.L_EYE_O], [LM.L_EYE_O, LM.L_EAR],
  [LM.NOSE, LM.R_EYE_I], [LM.R_EYE_I, LM.R_EYE], [LM.R_EYE, LM.R_EYE_O], [LM.R_EYE_O, LM.R_EAR],
  // Torso
  [LM.L_SHOULDER, LM.R_SHOULDER],
  [LM.L_SHOULDER, LM.L_HIP], [LM.R_SHOULDER, LM.R_HIP],
  [LM.L_HIP, LM.R_HIP],
  // Left arm
  [LM.L_SHOULDER, LM.L_ELBOW], [LM.L_ELBOW, LM.L_WRIST],
  [LM.L_WRIST, LM.L_PINKY], [LM.L_WRIST, LM.L_INDEX], [LM.L_WRIST, LM.L_THUMB],
  // Right arm
  [LM.R_SHOULDER, LM.R_ELBOW], [LM.R_ELBOW, LM.R_WRIST],
  [LM.R_WRIST, LM.R_PINKY], [LM.R_WRIST, LM.R_INDEX], [LM.R_WRIST, LM.R_THUMB],
  // Left leg
  [LM.L_HIP, LM.L_KNEE], [LM.L_KNEE, LM.L_ANKLE],
  [LM.L_ANKLE, LM.L_HEEL], [LM.L_ANKLE, LM.L_FOOT_I],
  // Right leg
  [LM.R_HIP, LM.R_KNEE], [LM.R_KNEE, LM.R_ANKLE],
  [LM.R_ANKLE, LM.R_HEEL], [LM.R_ANKLE, LM.R_FOOT_I],
];

// Key joint landmark indices to draw as circles
const KEY_JOINTS = [
  LM.NOSE,
  LM.L_SHOULDER, LM.R_SHOULDER,
  LM.L_ELBOW, LM.R_ELBOW,
  LM.L_WRIST, LM.R_WRIST,
  LM.L_HIP, LM.R_HIP,
  LM.L_KNEE, LM.R_KNEE,
  LM.L_ANKLE, LM.R_ANKLE,
];

function drawSkeleton(lm, poseColor) {
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  if (!lm || lm.length === 0) return;

  const W = canvasEl.width;
  const H = canvasEl.height;

  // Helper: convert normalized → canvas coords
  const px = (p) => ({ x: p.x * W, y: p.y * H });

  // Draw connections
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';

  for (const [i, j] of POSE_CONNECTIONS) {
    const a = lm[i], b = lm[j];
    if (!a || !b) continue;
    if (a.visibility < 0.4 || b.visibility < 0.4) continue;

    const pa = px(a), pb = px(b);
    const vis = Math.min(a.visibility, b.visibility);

    ctx.globalAlpha = Math.min(vis, 1.0);
    ctx.strokeStyle = poseColor;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // Draw joint circles
  for (const idx of KEY_JOINTS) {
    const p = lm[idx];
    if (!p || p.visibility < 0.4) continue;
    const { x, y } = px(p);

    ctx.globalAlpha = Math.min(p.visibility, 1.0);

    // Outer ring
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = poseColor;
    ctx.fill();

    // Inner dot
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#0A0A0F';
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

/* ──────────────────────────────────────────────
   12. FRAME VISIBILITY CHECK
────────────────────────────────────────────── */
function checkPoseVisible(lm) {
  // Require key upper and lower body landmarks
  const required = [
    LM.L_SHOULDER, LM.R_SHOULDER,
    LM.L_HIP, LM.R_HIP,
  ];
  return required.every(i => isVisible(lm, i, CONFIDENCE_THRESHOLD));
}

/* ──────────────────────────────────────────────
   13. MAIN RESULTS HANDLER (called per frame)
────────────────────────────────────────────── */
let frameCount = 0;
const CALC_EVERY = 2; // throttle heavy math to every 2nd frame

let lastAngle = null;
let lastPoseOk = true;
let lastPoseColor = '#00E676';

function onPoseResults(results) {
  frameCount++;

  // Sync canvas to camera wrap size
  const wrap = document.getElementById('camera-wrap');
  if (canvasEl.width !== wrap.clientWidth || canvasEl.height !== wrap.clientHeight) {
    canvasEl.width = wrap.clientWidth;
    canvasEl.height = wrap.clientHeight;
  }

  const lm = results.poseLandmarks;

  if (!lm || lm.length === 0) {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    showFrameAlert(true);
    setStatus('No Pose', 'red');
    return;
  }

  const poseVisible = checkPoseVisible(lm);
  showFrameAlert(!poseVisible);

  if (!poseVisible) {
    drawSkeleton(lm, '#FF1744');
    setStatus('Stand in Frame', 'red');
    return;
  }

  // Throttle heavy calculations
  if (frameCount % CALC_EVERY !== 0) {
    // Still draw skeleton with cached color
    drawSkeleton(lm, lastPoseColor);
    return;
  }

  // Get primary angle
  const rawAngle = getPrimaryAngle(lm);
  if (rawAngle === null) {
    drawSkeleton(lm, '#FFD600');
    setStatus('Adjust Pose', 'yellow');
    return;
  }

  lastAngle = rawAngle;

  // Check body alignment (pushups, planks)
  const needsBodyCheck = ['pushup', 'pullup'].includes(workoutKey);
  const bodyOk = needsBodyCheck ? isBodyStraight(lm) : true;

  // Process rep
  const { counted, angle } = processRep(rawAngle);

  if (counted) {
    updateRepUI(true);
    speakRep(currentReps);
    sendToFlutter(currentReps);
  }

  // Pose quality
  const { down, up } = thresholds;
  const invertedWorkouts = ['pullup', 'bicep_curl'];
  const inv = invertedWorkouts.includes(workoutKey);
  const inGoodRange = inv
    ? (angle <= up || angle >= down)
    : (angle >= down && angle <= up + 20);

  lastPoseOk = bodyOk && poseVisible;
  lastPoseColor = lastPoseOk ? '#00E676' : '#FF1744';

  drawSkeleton(lm, lastPoseColor);
  updateAngleUI(angle, bodyOk);

  // Status
  if (!bodyOk) {
    setStatus('Align Body', 'red');
  } else if (repPhase === 'DOWN') {
    setStatus('Going Down', 'yellow');
  } else {
    setStatus('Good Form', 'green');
  }

  // Feedback toast throttle
  const now = Date.now();
  if (now - lastFeedbackTime > FEEDBACK_THROTTLE_MS) {
    const fb = getFeedback(angle, bodyOk);
    showFeedbackToast(fb.msg, fb.cls);
    lastFeedbackTime = now;
  }
}

/* ──────────────────────────────────────────────
   14. MEDIAPIPE POSE INITIALIZATION
────────────────────────────────────────────── */
function initPose() {
  const pose = new Pose({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
  });

  pose.setOptions({
    modelComplexity: 1,       // 0=lite, 1=full, 2=heavy — balanced
    smoothLandmarks: true,
    enableSegmentation: false,   // off for performance
    smoothSegmentation: false,
    minDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });

  pose.onResults(onPoseResults);
  return pose;
}

/* ──────────────────────────────────────────────
   15. CAMERA INITIALIZATION
────────────────────────────────────────────── */
function initCamera(pose) {
  const camera = new Camera(videoEl, {
    onFrame: async () => {
      await pose.send({ image: videoEl });
    },
    width: 720,
    height: 1280,
    facingMode: 'user',
  });
  camera.start();
}

/* ──────────────────────────────────────────────
   16. LOADING SCREEN HANDLER
────────────────────────────────────────────── */
function runLoadingSequence(onReady) {
  const bar = loaderBar;
  let progress = 0;

  const steps = [
    { to: 30, delay: 200 },
    { to: 60, delay: 600 },
    { to: 85, delay: 800 },
    { to: 100, delay: 400 },
  ];

  let i = 0;
  function nextStep() {
    if (i >= steps.length) {
      setTimeout(onReady, 300);
      return;
    }
    const step = steps[i++];
    setTimeout(() => {
      progress = step.to;
      bar.style.width = `${progress}%`;
      nextStep();
    }, step.delay);
  }
  nextStep();
}

function showApp() {
  const loadScreen = document.getElementById('loading-screen');
  const app = document.getElementById('app');

  loadScreen.classList.add('fade-out');
  setTimeout(() => {
    loadScreen.style.display = 'none';
    app.classList.remove('hidden');
    app.classList.add('show');
  }, 500);
}

/* ──────────────────────────────────────────────
   17. FLUTTER BACK BUTTON
────────────────────────────────────────────── */
function handleBack() {
  try {
    if (window.flutter_inappwebview) {
      window.flutter_inappwebview.callHandler('onBackPressed', {});
    } else {
      history.back();
    }
  } catch (_) {
    history.back();
  }
}

/* ──────────────────────────────────────────────
   18. ENTRY POINT
────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  // Initial UI state
  updateRepUI();
  setStatus('Loading…', 'yellow');
  showFeedbackToast('Initializing…', '');

  runLoadingSequence(() => {
    const pose = initPose();
    initCamera(pose);
    showApp();
    setStatus('Ready', 'green');
    showFeedbackToast('Get into position!', 'good');
  });
});

/* ──────────────────────────────────────────────
   19. RESIZE HANDLER — canvas stays in sync
────────────────────────────────────────────── */
window.addEventListener('resize', () => {
  const wrap = document.getElementById('camera-wrap');
  canvasEl.width = wrap.clientWidth;
  canvasEl.height = wrap.clientHeight;
});

/* ──────────────────────────────────────────────
   20. VISIBILITY API — pause/resume on tab hide
────────────────────────────────────────────── */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    synth && synth.cancel();
  }
});