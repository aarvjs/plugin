/* ═══════════════════════════════════════════════════════════
   FITLIX AI TRAINER — script.js v2
   MediaPipe Pose | Anti-Cheat Body Orientation | Rep Counting
═══════════════════════════════════════════════════════════ */

'use strict';

/* ──────────────────────────────────────────────
   0. CONSTANTS & GLOBAL STATE
────────────────────────────────────────────── */
const CONFIDENCE_THRESHOLD = 0.60;
const MIN_REP_DURATION_MS = 800;
const ANGLE_SMOOTH_WINDOW = 5;
const FEEDBACK_THROTTLE_MS = 1200;
const MIN_GOOD_FORM_FRAMES = 2;
const PHASE_CONFIRM_FRAMES = 2;
const DOWN_HOLD_MIN_MS = 120;
const THRESHOLD_HYSTERESIS_DEG = 4;
const CALIBRATION_MIN_FRAMES = 28;
const CALIBRATION_MAX_FRAMES = 120;
const CALIBRATION_MIN_RANGE_DEG = 24;
const DEBUG_VERBOSE = false;
const FRAME_DEBUG_EVERY = 90;

// ── Body orientation required by each exercise.
// This is the KEY anti-cheat: prevents e.g. bicep curls being counted in pushup mode.
const EXERCISE_BODY_ORIENTATION = {
  pushup: 'horizontal',        // lying plank position
  pullup: 'vertical_arms_up',  // hanging, arms above head
  bicep_curl: 'vertical',          // standing
  shoulder_press: 'vertical',          // standing/seated
  squat: 'vertical',          // standing
  lunge: 'vertical',          // standing
  situp: 'horizontal',        // lying on back
  jumping_jack: 'vertical',          // standing
};

// Human-readable message shown when body position is wrong for chosen exercise
const WRONG_POSITION_MSGS = {
  pushup: '📐 Get into plank position for push-ups',
  pullup: '🙌 Hang from the bar with arms up for pull-ups',
  bicep_curl: '🧍 Stand upright for bicep curls',
  shoulder_press: '🧍 Stand/sit upright for shoulder press',
  squat: '🧍 Stand upright for squats',
  lunge: '🧍 Stand upright for lunges',
  situp: '🛏️ Lie on your back for sit-ups',
  jumping_jack: '🧍 Stand upright for jumping jacks',
};

const OPEN_EXERCISE_FEED_URLS = [
  'https://cdn.jsdelivr.net/gh/exercemus/exercises@minified/minified-exercises.json',
  'https://raw.githubusercontent.com/exercemus/exercises/minified/minified-exercises.json',
];

/* ── EDB RAPIDAPI CONFIG ── */
const EDB_API_KEY    = '02450b2ba4mshb0a631f203f8dd5p185fe4jsn6fc5c5485837';
const EDB_API_HOST   = 'edb-with-videos-and-images-by-ascendapi.p.rapidapi.com';
const EDB_API_BASE   = `https://${EDB_API_HOST}/api/v1`;
const EDB_CACHE_TTL  = 60 * 60 * 1000; // 1 hour in ms

// Maps internal workout keys → search terms for the EDB API
const EDB_SEARCH_QUERY = {
  pushup:         'push up',
  squat:          'squat',
  pullup:         'pull up',
  lunge:          'lunge',
  situp:          'sit up',
  bicep_curl:     'bicep curl',
  shoulder_press: 'shoulder press',
  jumping_jack:   'jumping jack',
};

const INVERTED_WORKOUTS = new Set(['pullup', 'bicep_curl']);

const MIN_REP_RANGE_BY_WORKOUT = {
  pushup: 24, squat: 30, pullup: 28, lunge: 24,
  situp: 28, bicep_curl: 30, shoulder_press: 34, jumping_jack: 26,
};

const bootTime = Date.now();
window.__fitlixLogs = window.__fitlixLogs || [];

function debugLog(level, step, message, data) {
  const elapsedMs = Date.now() - bootTime;
  const payload = { ts: new Date().toISOString(), elapsedMs, level, step, message, data: data === undefined ? null : data };
  window.__fitlixLogs.push(payload);
  const prefix = `[FITLIX][+${String(elapsedMs).padStart(5, '0')}ms][${step}]`;
  if (level === 'error') console.error(prefix, message, data || '');
  else if (level === 'warn') console.warn(prefix, message, data || '');
  else if (DEBUG_VERBOSE) console.log(prefix, message, data || '');
}

function logInfo(step, msg, data) { debugLog('info', step, msg, data); }
function logWarn(step, msg, data) { debugLog('warn', step, msg, data); }
function logError(step, msg, data) { debugLog('error', step, msg, data); }

window.addEventListener('error', (e) => logError('window.error', e.message || 'Unhandled error', { file: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => logError('window.promise', 'Unhandled rejection', { reason: String(e.reason || '') }));

/* ── WORKOUT META ── */
const WorkoutMeta = {
  pushup: {
    name: 'Push-Up', icon: '💪', joints: ['elbow', 'body'], primary: 'elbow',
    guide: [
      'Place hands slightly wider than shoulder-width.',
      'Keep your body in a rigid straight line from head to heels — no hip sag.',
      'Lower your chest until it nearly touches the floor.',
      'Push back to full arm extension.',
    ]
  },
  squat: {
    name: 'Squat', icon: '🏋️', joints: ['knee', 'hip'], primary: 'knee',
    guide: [
      'Stand with feet shoulder-width apart, toes slightly out.',
      'Keep your chest up and spine neutral throughout.',
      'Drive hips back and down until knees reach 90°.',
      'Keep knees tracking over toes, weight through heels.',
    ]
  },
  pullup: {
    name: 'Pull-Up', icon: '🦾', joints: ['elbow', 'body'], primary: 'elbow',
    guide: [
      'Grip the bar just wider than shoulder-width, palms facing away.',
      'Start with arms fully extended, body straight.',
      'Pull until your chin clears the bar, squeezing your shoulder blades.',
      'Lower with control — no swinging or kipping.',
    ]
  },
  lunge: {
    name: 'Lunge', icon: '🦵', joints: ['knee'], primary: 'knee',
    guide: [
      'Stand tall, step one foot forward about two feet.',
      'Lower until both knees form roughly 90° angles.',
      'Front knee stays above front ankle — never past your toes.',
      'Drive through front heel to return to start.',
    ]
  },
  situp: {
    name: 'Sit-Up', icon: '🔥', joints: ['hip'], primary: 'hip',
    guide: [
      'Lie on your back with knees bent and feet flat.',
      'Place fingertips lightly behind your ears — don\'t pull your neck.',
      'Engage your core and lift your torso toward your knees.',
      'Lower back down slowly with control.',
    ]
  },
  bicep_curl: {
    name: 'Bicep Curl', icon: '💪', joints: ['elbow'], primary: 'elbow',
    guide: [
      'Stand tall, hold weights with palms facing forward.',
      'Pin elbows firmly to your sides — they must not drift forward.',
      'Curl the weights up toward your shoulders in a smooth arc.',
      'Lower slowly to full extension on every rep.',
    ]
  },
  shoulder_press: {
    name: 'Shoulder Press', icon: '🏋️', joints: ['elbow'], primary: 'elbow',
    guide: [
      'Hold weights at shoulder height with palms facing forward.',
      'Brace your core — no lower-back arch.',
      'Press overhead until arms are nearly fully extended.',
      'Lower with control back to shoulder height.',
    ]
  },
  jumping_jack: {
    name: 'Jumping Jacks', icon: '⚡', joints: ['arm_spread'], primary: 'arm_spread',
    guide: [
      'Start upright with legs together and arms at sides.',
      'Jump and simultaneously spread legs wider than shoulder-width.',
      'Swing arms fully overhead at the same time.',
      'Jump back to start in one smooth movement.',
    ]
  },
};

// Local video files kept as last-resort fallback (may not exist on server)
const LocalCoachVideoMeta = {
  pushup:         { good: 'videos/pushup-good.mp4',         bad: 'videos/pushup-bad.mp4' },
  squat:          { good: 'videos/squat-good.mp4',          bad: 'videos/squat-bad.mp4' },
  pullup:         { good: 'videos/pullup-good.mp4',         bad: 'videos/pullup-bad.mp4' },
  lunge:          { good: 'videos/lunge-good.mp4',          bad: 'videos/lunge-bad.mp4' },
  situp:          { good: 'videos/situp-good.mp4',          bad: 'videos/situp-bad.mp4' },
  bicep_curl:     { good: 'videos/bicep_curl-good.mp4',     bad: 'videos/bicep_curl-bad.mp4' },
  shoulder_press: { good: 'videos/shoulder_press-good.mp4', bad: 'videos/shoulder_press-bad.mp4' },
  jumping_jack:   { good: 'videos/jumping_jack-good.mp4',   bad: 'videos/jumping_jack-bad.mp4' },
};

const OpenSourceWorkoutQuery = {
  pushup: { include: ['push up', 'push-up', 'pushup'], avoid: ['knee push', 'wall push', 'pike'] },
  squat: { include: ['bodyweight squat', 'squat', 'air squat'], avoid: ['jump squat', 'goblet squat', 'smith machine'] },
  pullup: { include: ['pull up', 'pull-up', 'pullup'], avoid: ['assisted', 'lat pulldown', 'chin up'] },
  lunge: { include: ['forward lunge', 'lunge', 'walking lunge'], avoid: ['jump lunge', 'reverse lunge'] },
  situp: { include: ['sit up', 'sit-up', 'situp', 'crunch'], avoid: ['v-up', 'decline'] },
  bicep_curl: { include: ['bicep curl', 'biceps curl', 'dumbbell curl'], avoid: ['hammer curl', 'concentration curl'] },
  shoulder_press: { include: ['shoulder press', 'overhead press', 'military press'], avoid: ['arnold press', 'push press'] },
  jumping_jack: { include: ['jumping jack', 'jumping jacks'], avoid: ['half jack', 'step jack'] },
};

const WorkoutMistakeTips = {
  pushup: ['Letting hips sag or pike up', 'Flaring elbows out wider than 45°', 'Not reaching full depth'],
  squat: ['Knees caving inward', 'Heels lifting off the floor', 'Excessive forward torso lean'],
  pullup: ['Kipping or swinging for momentum', 'Chin not clearing the bar', 'Not fully extending at bottom'],
  lunge: ['Front knee collapsing inward', 'Torso leaning excessively forward', 'Too short a step length'],
  situp: ['Pulling on neck with hands', 'Twisting torso unevenly', 'Using momentum instead of core'],
  bicep_curl: ['Elbows drifting forward away from body', 'Swinging torso for help', 'Dropping the weight too fast'],
  shoulder_press: ['Overarching lower back', 'Wrists not stacked above shoulders', 'Flaring elbows forward'],
  jumping_jack: ['Arms not fully overhead', 'Knees collapsing inward on landing', 'Landing too stiff / no shock absorption'],
};

const WorkoutThresholds = {
  pushup: { down: 90, up: 145, downLabel: 'Go Lower', upLabel: 'Push Up' },
  squat: { down: 100, up: 145, downLabel: 'Go Deeper', upLabel: 'Stand Up' },
  pullup: { down: 160, up: 60, downLabel: 'Go Lower', upLabel: 'Pull Up' },
  lunge: { down: 90, up: 160, downLabel: 'Go Deeper', upLabel: 'Stand Up' },
  situp: { down: 60, up: 120, downLabel: 'Go Down', upLabel: 'Sit Up' },
  bicep_curl: { down: 160, up: 50, downLabel: 'Lower Arm', upLabel: 'Curl Up' },
  shoulder_press: { down: 90, up: 160, downLabel: 'Go Lower', upLabel: 'Press Up' },
  jumping_jack: { down: 35, up: 125, downLabel: 'Arms Up', upLabel: 'Arms Down' },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* ── MEDIAPIPE LANDMARK INDICES ── */
const LM = {
  NOSE: 0,
  L_EYE_I: 1, L_EYE: 2, L_EYE_O: 3,
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

const SIDE = {
  L: { SHOULDER: LM.L_SHOULDER, ELBOW: LM.L_ELBOW, WRIST: LM.L_WRIST, EAR: LM.L_EAR, HIP: LM.L_HIP, KNEE: LM.L_KNEE, ANKLE: LM.L_ANKLE, FOOT: LM.L_FOOT_I },
  R: { SHOULDER: LM.R_SHOULDER, ELBOW: LM.R_ELBOW, WRIST: LM.R_WRIST, EAR: LM.R_EAR, HIP: LM.R_HIP, KNEE: LM.R_KNEE, ANKLE: LM.R_ANKLE, FOOT: LM.R_FOOT_I },
};

/* ──────────────────────────────────────────────
   1. URL PARAMS & WORKOUT SETUP
────────────────────────────────────────────── */
const hashMatch = window.location.hash.replace('#', '');
const urlParams = new URLSearchParams(window.location.search);
const rawWorkout = hashMatch || urlParams.get('workout') || null;
const workoutKey = (rawWorkout || 'pushup').toLowerCase().replace('-', '_');
const meta = WorkoutMeta[workoutKey] || WorkoutMeta.pushup;
const thresholds = WorkoutThresholds[workoutKey] || WorkoutThresholds.pushup;
const isFileOrigin = window.location.protocol === 'file:';

let activeThresholds = { ...thresholds };
let calibrationState = {
  done: false, frames: 0,
  minAngle: Infinity, maxAngle: -Infinity,
};

function navigateToWorkout(key) {
  const normalizedKey = String(key || '').toLowerCase().replace('-', '_');
  const baseUrl = window.location.href.split('#')[0].split('?')[0];
  window.location.replace(`${baseUrl}#${normalizedKey}`);
  window.location.reload();
}

function navigateToHome() {
  const baseUrl = window.location.href.split('#')[0].split('?')[0];
  window.location.replace(baseUrl);
}

function selectWorkout(key) {
  navigateToWorkout(key);
}

const workoutNameNode = document.getElementById('workout-name');
const workoutIconNode = document.getElementById('workout-icon');
if (workoutNameNode) workoutNameNode.textContent = meta.name;
if (workoutIconNode) workoutIconNode.textContent = meta.icon;

/* ──────────────────────────────────────────────
   2. DOM REFERENCES
────────────────────────────────────────────── */
const videoEl = document.getElementById('input-video');
const canvasEl = document.getElementById('pose-canvas');
const ctx = canvasEl.getContext('2d');
const frameAlertEl = document.getElementById('frame-alert');
const positionAlertEl = document.getElementById('position-alert');
const positionAlertTextEl = document.getElementById('position-alert-text');
const feedbackEl = document.getElementById('feedback-toast');
const statRepsEl = document.getElementById('stat-reps');
const topRepsEl = document.getElementById('top-reps');
const statAngleEl = document.getElementById('stat-angle');
const statStatusEl = document.getElementById('stat-status');
const statusDotEl = document.getElementById('status-dot');
const loaderBar = document.getElementById('loader-bar');
const coachPreviewEl = document.getElementById('coach-preview');
const coachPreviewTitleEl = document.getElementById('coach-preview-title');
const coachSourceEl = document.getElementById('coach-source');
const coachGoodVideoEl = document.getElementById('coach-good-video');
const coachGoodGifEl = document.getElementById('coach-good-gif');
const coachBadVideoEl = document.getElementById('coach-bad-video');
const coachBadGifEl = document.getElementById('coach-bad-gif');
const coachGoodEmbedId = 'coach-good-embed';
const coachBadEmbedId = 'coach-bad-embed';
const coachGoodLoadingEl = document.getElementById('coach-good-loading');
const coachBadLoadingEl = document.getElementById('coach-bad-loading');
const coachGoodFallbackEl = document.getElementById('coach-good-fallback');
const coachBadFallbackEl = document.getElementById('coach-bad-fallback');
const coachBadMistakesEl = document.getElementById('coach-bad-mistakes');

/* ──────────────────────────────────────────────
   3. REP STATE MACHINE
────────────────────────────────────────────── */
let currentReps = 0;
let repPhase = 'UP';
let lastRepTime = 0;
let lastFeedbackTime = 0;
let goodFormStreak = 0;
let lastPrimaryAngle = null;
let lastPrimaryAngleTs = 0;
let downFrameStreak = 0;
let upFrameStreak = 0;
let downEnteredAt = 0;
let repMinAngle = Infinity;
let repMaxAngle = -Infinity;
let workoutEngineStarted = false;
let coachPreviewRequestId = 0;
let wrongPositionFrames = 0;   // consecutive frames with wrong body position

window.reps = 0;

const angleBuffers = {};

function smoothAngle(key, raw) {
  if (!angleBuffers[key]) angleBuffers[key] = [];
  const buf = angleBuffers[key];
  buf.push(raw);
  if (buf.length > ANGLE_SMOOTH_WINDOW) buf.shift();
  return buf.reduce((a, b) => a + b, 0) / buf.length;
}

/* ──────────────────────────────────────────────
   4. MATH & GEOMETRY HELPERS
────────────────────────────────────────────── */
function angleBetween(A, B, C) {
  const radians = Math.atan2(C.y - B.y, C.x - B.x) - Math.atan2(A.y - B.y, A.x - B.x);
  let deg = Math.abs(radians * (180 / Math.PI));
  if (deg > 180) deg = 360 - deg;
  return deg;
}

function isVisible(lm, idx, threshold = CONFIDENCE_THRESHOLD) {
  return lm && lm[idx] && lm[idx].visibility >= threshold;
}

function allVisible(lm, indices, threshold = CONFIDENCE_THRESHOLD) {
  return indices.every(i => isVisible(lm, i, threshold));
}

function getSidePoint(lm, side, part) {
  return lm[SIDE[side][part]];
}

function visibilityScore(lm, indices) {
  return indices.reduce((sum, idx) => sum + (lm[idx]?.visibility || 0), 0);
}

function pickBestSide(lm, parts, threshold = 0.5) {
  const leftIdx = parts.map(p => SIDE.L[p]);
  const rightIdx = parts.map(p => SIDE.R[p]);
  const leftOk = leftIdx.every(i => isVisible(lm, i, threshold));
  const rightOk = rightIdx.every(i => isVisible(lm, i, threshold));
  if (!leftOk && !rightOk) return null;
  if (leftOk && !rightOk) return 'L';
  if (!leftOk && rightOk) return 'R';
  return visibilityScore(lm, leftIdx) >= visibilityScore(lm, rightIdx) ? 'L' : 'R';
}

function torsoLeanFromVertical(lm, side) {
  const shoulder = getSidePoint(lm, side, 'SHOULDER');
  const hip = getSidePoint(lm, side, 'HIP');
  const vertical = { x: hip.x, y: hip.y - 1 };
  return angleBetween(shoulder, hip, vertical);
}

function bodyLineAngle(lm, side) {
  return angleBetween(
    getSidePoint(lm, side, 'SHOULDER'),
    getSidePoint(lm, side, 'HIP'),
    getSidePoint(lm, side, 'ANKLE')
  );
}

function getAngleSpeed(currentAngle) {
  const now = performance.now();
  if (lastPrimaryAngle === null || !lastPrimaryAngleTs) {
    lastPrimaryAngle = currentAngle; lastPrimaryAngleTs = now; return 0;
  }
  const dt = (now - lastPrimaryAngleTs) / 1000;
  if (dt <= 0) return 0;
  const speed = Math.abs(currentAngle - lastPrimaryAngle) / dt;
  lastPrimaryAngle = currentAngle; lastPrimaryAngleTs = now;
  return speed;
}

function getLungeFrontSide(lm) {
  const leftOk = allVisible(lm, [LM.L_HIP, LM.L_KNEE, LM.L_ANKLE], 0.5);
  const rightOk = allVisible(lm, [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE], 0.5);
  if (!leftOk && !rightOk) return null;
  if (leftOk && !rightOk) return 'L';
  if (!leftOk && rightOk) return 'R';
  const lAngle = angleBetween(lm[LM.L_HIP], lm[LM.L_KNEE], lm[LM.L_ANKLE]);
  const rAngle = angleBetween(lm[LM.R_HIP], lm[LM.R_KNEE], lm[LM.R_ANKLE]);
  return lAngle <= rAngle ? 'L' : 'R';
}

function getMinRepRange() {
  return (MIN_REP_RANGE_BY_WORKOUT[workoutKey] || 22) + 8;
}

function resetRepTracking() {
  downFrameStreak = 0; upFrameStreak = 0;
  downEnteredAt = 0;
  repMinAngle = Infinity; repMaxAngle = -Infinity;
}

/* ──────────────────────────────────────────────
   4.5 BODY ORIENTATION VALIDATION
   ★ THE CORE FIX: prevents cross-exercise counting
   e.g. doing bicep curls in pushup mode won't count
────────────────────────────────────────────── */
function checkExerciseBodyPosition(lm) {
  const expectedOrientation = EXERCISE_BODY_ORIENTATION[workoutKey];
  if (!expectedOrientation) return true;

  switch (expectedOrientation) {

    case 'horizontal': {
      // Pushup / Situp: body should be roughly parallel to ground.
      // Y-spread from shoulder to ankle should be small (< ~0.40).
      // When standing: ySpread ≈ 0.55–0.70. When in plank: ySpread < 0.30.
      const side = pickBestSide(lm, ['SHOULDER', 'HIP', 'ANKLE'], 0.35);
      if (!side) return true; // can't determine — let it through
      const shoulder = getSidePoint(lm, side, 'SHOULDER');
      const ankle = getSidePoint(lm, side, 'ANKLE');
      const ySpread = Math.abs(shoulder.y - ankle.y);
      return ySpread <= 0.42;
    }

    case 'vertical': {
      // Bicep curl / Shoulder press / Squat / Lunge / Jumping jack:
      // Body must be upright — shoulder clearly above hip on screen (smaller y = higher).
      const side = pickBestSide(lm, ['SHOULDER', 'HIP'], 0.40);
      if (!side) return true;
      const shoulder = getSidePoint(lm, side, 'SHOULDER');
      const hip = getSidePoint(lm, side, 'HIP');
      // hip.y > shoulder.y means hip is lower on screen (correct for standing)
      return (hip.y - shoulder.y) > 0.10;
    }

    case 'vertical_arms_up': {
      // Pull-up: body must be vertical AND wrists must be above (or near) the shoulders.
      const side = pickBestSide(lm, ['SHOULDER', 'WRIST', 'HIP'], 0.40);
      if (!side) return true;
      const shoulder = getSidePoint(lm, side, 'SHOULDER');
      const wrist = getSidePoint(lm, side, 'WRIST');
      const hip = getSidePoint(lm, side, 'HIP');
      const bodyVertical = (hip.y - shoulder.y) > 0.10;
      // Wrist at or above shoulder level means wrist.y <= shoulder.y + small margin
      const armsUp = wrist.y <= (shoulder.y + 0.12);
      return bodyVertical && armsUp;
    }

    default:
      return true;
  }
}

/* ──────────────────────────────────────────────
   4.6 CALIBRATION
────────────────────────────────────────────── */
function updateThresholdCalibration(angle) {
  if (calibrationState.done || !Number.isFinite(angle)) return;
  calibrationState.frames++;
  calibrationState.minAngle = Math.min(calibrationState.minAngle, angle);
  calibrationState.maxAngle = Math.max(calibrationState.maxAngle, angle);

  const range = calibrationState.maxAngle - calibrationState.minAngle;
  const enoughFrames = calibrationState.frames >= CALIBRATION_MIN_FRAMES;
  const shouldFinaliz = (enoughFrames && range >= CALIBRATION_MIN_RANGE_DEG) || calibrationState.frames >= CALIBRATION_MAX_FRAMES;
  if (!shouldFinaliz) return;

  if (range < 16) {
    if (calibrationState.frames >= CALIBRATION_MAX_FRAMES) {
      calibrationState.frames = 0;
      calibrationState.minAngle = Infinity;
      calibrationState.maxAngle = -Infinity;
    }
    return;
  }

  calibrationState.done = true;
  const inverted = INVERTED_WORKOUTS.has(workoutKey);
  const minSpan = Math.max(getMinRepRange(), 18);
  let down = thresholds.down;
  let up = thresholds.up;

  if (!inverted) {
    down = calibrationState.minAngle + range * 0.30;
    up = calibrationState.maxAngle - range * 0.20;
    if (up - down < minSpan) { const mid = (up + down) / 2; down = mid - minSpan / 2; up = mid + minSpan / 2; }
  } else {
    down = calibrationState.maxAngle - range * 0.25;
    up = calibrationState.minAngle + range * 0.25;
    if (down - up < minSpan) { const mid = (down + up) / 2; up = mid - minSpan / 2; down = mid + minSpan / 2; }
  }

  activeThresholds = {
    ...thresholds,
    down: clamp(down, thresholds.down - 24, thresholds.down + 24),
    up: clamp(up, thresholds.up - 24, thresholds.up + 24),
  };
}

function isBodyStraight(lm) {
  const sides = [[LM.L_SHOULDER, LM.L_HIP, LM.L_ANKLE], [LM.R_SHOULDER, LM.R_HIP, LM.R_ANKLE]];
  for (const [s, h, a] of sides) {
    if (!allVisible(lm, [s, h, a], 0.5)) continue;
    if (angleBetween(lm[s], lm[h], lm[a]) < 135) return false;
  }
  return true;
}

/* ──────────────────────────────────────────────
   4.7 POSTURE ANALYSIS
────────────────────────────────────────────── */
function analyzePosture(lm, primaryAngle, angleSpeedDps = 0) {
  let score = 100;
  let errorMsg = null;
  const markBad = (msg, penalty = 20) => { score -= penalty; if (!errorMsg) errorMsg = msg; };

  switch (workoutKey) {

    case 'pushup': {
      const side = pickBestSide(lm, ['SHOULDER', 'HIP', 'ANKLE', 'WRIST'], 0.5);
      if (!side) { markBad('Move back — show full side profile.', 50); break; }
      const shoulder = getSidePoint(lm, side, 'SHOULDER');
      const hip = getSidePoint(lm, side, 'HIP');
      const ankle = getSidePoint(lm, side, 'ANKLE');
      const lineAng = bodyLineAngle(lm, side);
      
      if (lineAng < 150) {
        if (hip.y > (shoulder.y + ankle.y)/2 + 0.05) markBad("Hips sagging! Tighten core.", 30);
        else markBad("Piking hips! Keep body straight.", 25);
      }
      if (primaryAngle > 165 && repPhase === 'UP') markBad("Lock arms at top.", 10);
      if (primaryAngle < 100 && repPhase === 'DOWN') markBad("Go lower for full depth.", 15);
      break;
    }

    case 'squat': {
      const side = pickBestSide(lm, ['SHOULDER', 'HIP', 'KNEE', 'ANKLE'], 0.5);
      if (!side) { markBad('Show side profile for squat check.', 45); break; }
      const torsoAngle = torsoLeanFromVertical(lm, side);
      if (torsoAngle > 45) markBad('Keep chest up — don\'t lean forward.', 25);
      
      if (primaryAngle > 160 && repPhase === 'UP') markBad('Stand tall at top.', 10);
      if (primaryAngle < 110 && repPhase === 'DOWN') markBad('Hips lower! Aim for 90°.', 15);
      break;
    }

    case 'bicep_curl': {
      const side = pickBestSide(lm, ['SHOULDER', 'ELBOW', 'WRIST', 'HIP'], 0.5);
      if (!side) { markBad('Show upper body profile.', 40); break; }
      const shoulder = getSidePoint(lm, side, 'SHOULDER');
      const elbow = getSidePoint(lm, side, 'ELBOW');
      if (Math.abs(elbow.x - shoulder.x) > 0.12) markBad('Keep elbows pinned at sides!', 25);
      if (primaryAngle > 160 && repPhase === 'UP') markBad('Full extension at bottom.', 15);
      break;
    }

    case 'jumping_jack': {
      const needs = [LM.L_WRIST, LM.R_WRIST, LM.L_ANKLE, LM.R_ANKLE];
      if (!allVisible(lm, needs, 0.5)) { markBad('Keep full body in frame.', 50); break; }
      if (primaryAngle < 100 && repPhase === 'UP') markBad('Reach arms fully overhead.', 20);
      break;
    }

    default: break;
  }

  const isOk = score >= 70;
  return { isOk, errorMsg: isOk ? null : (errorMsg || 'Adjust posture.'), score };
}

/* ──────────────────────────────────────────────
   5. PRIMARY ANGLE EXTRACTORS
────────────────────────────────────────────── */
function getPrimaryAngle(lm) {
  switch (workoutKey) {

    case 'pushup':
    case 'pullup':
    case 'bicep_curl':
    case 'shoulder_press': {
      const side = pickBestSide(lm, ['SHOULDER', 'ELBOW', 'WRIST'], 0.5);
      if (!side) return null;
      return angleBetween(getSidePoint(lm, side, 'SHOULDER'), getSidePoint(lm, side, 'ELBOW'), getSidePoint(lm, side, 'WRIST'));
    }

    case 'squat': {
      const side = pickBestSide(lm, ['HIP', 'KNEE', 'ANKLE'], 0.5);
      if (!side) return null;
      return angleBetween(getSidePoint(lm, side, 'HIP'), getSidePoint(lm, side, 'KNEE'), getSidePoint(lm, side, 'ANKLE'));
    }

    case 'lunge': {
      const frontSide = getLungeFrontSide(lm);
      if (!frontSide) return null;
      return angleBetween(getSidePoint(lm, frontSide, 'HIP'), getSidePoint(lm, frontSide, 'KNEE'), getSidePoint(lm, frontSide, 'ANKLE'));
    }

    case 'situp': {
      const side = pickBestSide(lm, ['SHOULDER', 'HIP', 'KNEE'], 0.5);
      if (!side) return null;
      return angleBetween(getSidePoint(lm, side, 'SHOULDER'), getSidePoint(lm, side, 'HIP'), getSidePoint(lm, side, 'KNEE'));
    }

    case 'jumping_jack': {
      const needs = [LM.L_WRIST, LM.L_SHOULDER, LM.L_HIP, LM.R_WRIST, LM.R_SHOULDER, LM.R_HIP];
      if (!allVisible(lm, needs, 0.5)) return null;
      const left = angleBetween(lm[LM.L_WRIST], lm[LM.L_SHOULDER], lm[LM.L_HIP]);
      const right = angleBetween(lm[LM.R_WRIST], lm[LM.R_SHOULDER], lm[LM.R_HIP]);
      return (left + right) / 2;
    }

    default: return null;
  }
}

/* ──────────────────────────────────────────────
   6. REP COUNTING
────────────────────────────────────────────── */
function processRep(rawAngle, formIsGood = true) {
  const angle = smoothAngle('primary', rawAngle);
  if (!formIsGood) { downFrameStreak = 0; upFrameStreak = 0; return { counted: false, angle }; }

  const now = Date.now();
  const { down, up } = activeThresholds;
  const inverted = INVERTED_WORKOUTS.has(workoutKey);

  const downEnter = inverted ? angle >= (down + THRESHOLD_HYSTERESIS_DEG) : angle <= (down - THRESHOLD_HYSTERESIS_DEG);
  const upEnter = inverted ? angle <= (up - THRESHOLD_HYSTERESIS_DEG) : angle >= (up + THRESHOLD_HYSTERESIS_DEG);

  if (repPhase === 'UP') {
    upFrameStreak = 0;
    downFrameStreak = downEnter ? (downFrameStreak + 1) : 0;
    if (downFrameStreak >= PHASE_CONFIRM_FRAMES) {
      repPhase = 'DOWN'; downEnteredAt = now;
      repMinAngle = angle; repMaxAngle = angle; downFrameStreak = 0;
    }
    return { counted: false, angle };
  }

  repMinAngle = Math.min(repMinAngle, angle);
  repMaxAngle = Math.max(repMaxAngle, angle);
  downFrameStreak = 0;
  upFrameStreak = upEnter ? (upFrameStreak + 1) : 0;

  if (upFrameStreak >= PHASE_CONFIRM_FRAMES) {
    const elapsed = now - lastRepTime;
    const downHold = now - downEnteredAt;
    const repRange = repMaxAngle - repMinAngle;
    const enoughRange = repRange >= getMinRepRange();
    repPhase = 'UP'; upFrameStreak = 0;
    repMinAngle = Infinity; repMaxAngle = -Infinity;

    if (elapsed >= MIN_REP_DURATION_MS && downHold >= DOWN_HOLD_MIN_MS && enoughRange) {
      currentReps++;
      window.reps = currentReps;
      lastRepTime = now;
      return { counted: true, angle };
    }
  }

  return { counted: false, angle };
}

/* ──────────────────────────────────────────────
   7. FEEDBACK
────────────────────────────────────────────── */
function getFeedback(angle, postureInfo) {
  if (!postureInfo.isOk) return { msg: postureInfo.errorMsg || 'Adjust Pose', cls: 'bad' };
  const { down, up } = activeThresholds;
  const inverted = INVERTED_WORKOUTS.has(workoutKey);
  if (repPhase === 'UP') {
    const halfwayDown = inverted
      ? (angle >= (up + (down - up) * 0.45))
      : (angle <= (up - (up - down) * 0.45));
    if (halfwayDown) return { msg: activeThresholds.downLabel, cls: 'warn' };
    return { msg: 'Good Form ✓', cls: 'good' };
  }
  return { msg: activeThresholds.upLabel, cls: 'warn' };
}

/* ──────────────────────────────────────────────
   8. VOICE FEEDBACK
────────────────────────────────────────────── */
const synth = window.speechSynthesis;
let isSpeaking = false;

function speakMsg(text, isUrgent = false) {
  if (!synth) return;
  if (isSpeaking && !isUrgent) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.1; u.pitch = 1.0; u.volume = 1.0;
  u.onstart = () => { isSpeaking = true; };
  u.onend = () => { isSpeaking = false; };
  if (isUrgent) synth.cancel();
  synth.speak(u);
}

function speakRep(count) { speakMsg(String(count), true); }

/* ──────────────────────────────────────────────
   9. UI UPDATES
────────────────────────────────────────────── */
function updateRepUI(animated = false) {
  statRepsEl.textContent = currentReps;
  topRepsEl.textContent = currentReps;
  if (animated) {
    [statRepsEl, topRepsEl].forEach(el => {
      el.classList.remove('rep-flash');
      void el.offsetWidth;
      el.classList.add('rep-flash');
    });
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

function showPositionAlert(visible, msg = '') {
  if (!positionAlertEl) return;
  if (visible && msg) positionAlertTextEl.textContent = msg;
  positionAlertEl.classList.toggle('hidden', !visible);
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
const POSE_CONNECTIONS = [
  [LM.NOSE, LM.L_EYE_I], [LM.L_EYE_I, LM.L_EYE], [LM.L_EYE, LM.L_EYE_O], [LM.L_EYE_O, LM.L_EAR],
  [LM.NOSE, LM.R_EYE_I], [LM.R_EYE_I, LM.R_EYE], [LM.R_EYE, LM.R_EYE_O], [LM.R_EYE_O, LM.R_EAR],
  [LM.L_SHOULDER, LM.R_SHOULDER],
  [LM.L_SHOULDER, LM.L_HIP], [LM.R_SHOULDER, LM.R_HIP],
  [LM.L_HIP, LM.R_HIP],
  [LM.L_SHOULDER, LM.L_ELBOW], [LM.L_ELBOW, LM.L_WRIST],
  [LM.L_WRIST, LM.L_PINKY], [LM.L_WRIST, LM.L_INDEX], [LM.L_WRIST, LM.L_THUMB],
  [LM.R_SHOULDER, LM.R_ELBOW], [LM.R_ELBOW, LM.R_WRIST],
  [LM.R_WRIST, LM.R_PINKY], [LM.R_WRIST, LM.R_INDEX], [LM.R_WRIST, LM.R_THUMB],
  [LM.L_HIP, LM.L_KNEE], [LM.L_KNEE, LM.L_ANKLE],
  [LM.L_ANKLE, LM.L_HEEL], [LM.L_ANKLE, LM.L_FOOT_I],
  [LM.R_HIP, LM.R_KNEE], [LM.R_KNEE, LM.R_ANKLE],
  [LM.R_ANKLE, LM.R_HEEL], [LM.R_ANKLE, LM.R_FOOT_I],
];

const KEY_JOINTS = [
  LM.NOSE, LM.L_SHOULDER, LM.R_SHOULDER,
  LM.L_ELBOW, LM.R_ELBOW, LM.L_WRIST, LM.R_WRIST,
  LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE,
];

function drawSkeleton(lm, poseColor) {
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  if (!lm || lm.length === 0) return;
  const W = canvasEl.width, H = canvasEl.height;
  const px = p => ({ x: p.x * W, y: p.y * H });

  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const [i, j] of POSE_CONNECTIONS) {
    const a = lm[i], b = lm[j];
    if (!a || !b || a.visibility < 0.4 || b.visibility < 0.4) continue;
    const pa = px(a), pb = px(b);
    ctx.globalAlpha = Math.min(Math.min(a.visibility, b.visibility), 1.0);
    ctx.strokeStyle = poseColor;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  for (const idx of KEY_JOINTS) {
    const p = lm[idx];
    if (!p || p.visibility < 0.4) continue;
    const { x, y } = px(p);
    ctx.globalAlpha = Math.min(p.visibility, 1.0);
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = poseColor; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#080B0F'; ctx.fill();
  }

  ctx.globalAlpha = 1;
}

/* ──────────────────────────────────────────────
   12. POSE VISIBILITY CHECK
────────────────────────────────────────────── */
function checkPoseVisible(lm) {
  return [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP].every(i => isVisible(lm, i, CONFIDENCE_THRESHOLD));
}

/* ──────────────────────────────────────────────
   13. MAIN FRAME HANDLER
────────────────────────────────────────────── */
let frameCount = 0;
const CALC_EVERY = 2;
let lastPoseColor = '#00E676';
let lastPoseDebugState = 'INIT';

function onPoseResults(results) {
  frameCount++;

  if (videoEl.videoWidth && videoEl.videoHeight) {
    if (canvasEl.width !== videoEl.videoWidth || canvasEl.height !== videoEl.videoHeight) {
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
    }
  }

  const lm = results.poseLandmarks;

  if (!lm || lm.length === 0) {
    goodFormStreak = 0; lastPrimaryAngle = null; lastPrimaryAngleTs = 0;
    repPhase = 'UP'; resetRepTracking();
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    showFrameAlert(true); showPositionAlert(false);
    setStatus('No Pose', 'red');
    return;
  }

  const poseVisible = checkPoseVisible(lm);
  showFrameAlert(!poseVisible);

  if (!poseVisible) {
    goodFormStreak = 0; repPhase = 'UP'; resetRepTracking();
    showPositionAlert(false);
    drawSkeleton(lm, '#FF3B5C');
    setStatus('Stand in Frame', 'red');
    return;
  }

  if (frameCount % CALC_EVERY !== 0) {
    drawSkeleton(lm, lastPoseColor);
    return;
  }

  const rawAngle = getPrimaryAngle(lm);
  if (rawAngle === null) {
    lastPrimaryAngle = null; lastPrimaryAngleTs = 0; resetRepTracking();
    drawSkeleton(lm, '#FFD600');
    setStatus('Adjust Pose', 'yellow');
    showPositionAlert(false);
    return;
  }

  updateThresholdCalibration(rawAngle);
  const angleSpeedDps = getAngleSpeed(rawAngle);

  // ── POSTURE ANALYSIS ──
  const postureInfo = analyzePosture(lm, rawAngle, angleSpeedDps);
  const bodyOk = postureInfo.isOk;
  goodFormStreak = bodyOk ? Math.min(goodFormStreak + 1, MIN_GOOD_FORM_FRAMES + 4) : 0;

  // ── BODY POSITION VALIDATION (anti-cross-exercise) ──
  const bodyPositionOk = checkExerciseBodyPosition(lm);

  if (!bodyPositionOk) {
    wrongPositionFrames = Math.min(wrongPositionFrames + 1, 8);
  } else {
    wrongPositionFrames = Math.max(wrongPositionFrames - 1, 0);
  }

  // Show the position alert after sustained wrong position (avoids flicker)
  const showingPositionAlert = wrongPositionFrames >= 4;
  showPositionAlert(showingPositionAlert && !postureInfo.errorMsg,
    WRONG_POSITION_MSGS[workoutKey] || 'Wrong position for this exercise');

  // Reps are allowed ONLY when posture AND body orientation are both correct
  const repAllowed = bodyOk && goodFormStreak >= MIN_GOOD_FORM_FRAMES && bodyPositionOk;
  const { counted, angle } = processRep(rawAngle, repAllowed);

  if (counted) {
    updateRepUI(true);
    speakRep(currentReps);
    sendToFlutter(currentReps);
  }

  lastPoseColor = (bodyOk && poseVisible && bodyPositionOk) ? '#00E676' : (bodyPositionOk ? '#FFD600' : '#FF3B5C');
  drawSkeleton(lm, lastPoseColor);
  updateAngleUI(angle, bodyOk);

  if (!bodyPositionOk) {
    setStatus('Wrong Position', 'red');
  } else if (!bodyOk) {
    setStatus('Fix Form', 'red');
  } else if (!calibrationState.done) {
    setStatus('Learning Range', 'yellow');
  } else if (!repAllowed) {
    setStatus('Hold Form', 'yellow');
  } else if (repPhase === 'DOWN') {
    setStatus(activeThresholds.upLabel, 'yellow');
  } else {
    setStatus('Good Form ✓', 'green');
  }

  const now = Date.now();
  if (now - lastFeedbackTime > FEEDBACK_THROTTLE_MS && bodyPositionOk) {
    const fb = getFeedback(angle, postureInfo);
    showFeedbackToast(fb.msg, fb.cls);
    if (fb.cls === 'bad' || fb.cls === 'warn') speakMsg(fb.msg, false);
    lastFeedbackTime = now;
  }
}

/* ──────────────────────────────────────────────
   14. MEDIAPIPE POSE
────────────────────────────────────────────── */
let poseInstance = null;

function initPose() {
  const pose = new Pose({
    locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
  });
  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    smoothSegmentation: false,
    minDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });
  pose.onResults(onPoseResults);
  poseInstance = pose;
  return pose;
}

/* ──────────────────────────────────────────────
   15. CAMERA
────────────────────────────────────────────── */
let cameraInstance = null;

function initCamera(pose) {
  const camera = new Camera(videoEl, {
    onFrame: async () => { await pose.send({ image: videoEl }); },
    width: 640, height: 480, facingMode: 'user',
  });
  cameraInstance = camera;
  camera.start();
}

/* ──────────────────────────────────────────────
   16. LOADING SCREEN
────────────────────────────────────────────── */
function runLoadingSequence(onReady) {
  const bar = loaderBar;
  if (!bar) { onReady(); return; }

  const steps = [
    { to: 20, delay: 150, text: 'Loading AI models...' },
    { to: 50, delay: 500, text: 'Preparing exercise data...' },
    { to: 80, delay: 700, text: 'Almost ready...' },
    { to: 100, delay: 350, text: 'Starting...' },
  ];

  const statusText = document.getElementById('loading-status-text');
  let i = 0;
  function nextStep() {
    if (i >= steps.length) { setTimeout(onReady, 280); return; }
    const step = steps[i++];
    setTimeout(() => {
      bar.style.width = `${step.to}%`;
      if (statusText) statusText.textContent = step.text;
      nextStep();
    }, step.delay);
  }
  nextStep();
}

function showApp() {
  const loadScreen = document.getElementById('loading-screen');
  const app = document.getElementById('app');
  if (!loadScreen || !app) return;
  loadScreen.classList.add('fade-out');
  setTimeout(() => {
    loadScreen.style.display = 'none';
    app.classList.remove('hidden');
    app.classList.add('show');
  }, 500);
}

function showFatalBootError(error) {
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080B0F;color:#fff;padding:24px;font-family:sans-serif;">
      <div style="max-width:500px;border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:24px;background:rgba(255,255,255,.04);">
        <h2 style="margin:0 0 10px;font-size:20px;">Fitlix Failed To Start</h2>
        <p style="margin:0 0 8px;color:rgba(255,255,255,.7);">Check console for <code>[FITLIX]</code> logs.</p>
        <p style="margin:0;color:#ff6b6b;font-size:13px;">${String(error)}</p>
      </div>
    </div>`;
}

/* ──────────────────────────────────────────────
   17. GUIDE
────────────────────────────────────────────── */
function toggleGuide() {
  const overlay = document.getElementById('guide-overlay');
  if (!overlay.classList.contains('hidden')) {
    overlay.classList.add('hidden');
    return;
  }
  document.getElementById('guide-title').textContent = meta.name;
  document.getElementById('guide-icon').textContent = meta.icon;
  const list = document.getElementById('guide-list');
  list.innerHTML = '';
  (meta.guide || ['Follow the on-screen cues for correct form.']).forEach(step => {
    const li = document.createElement('li');
    li.textContent = step;
    list.appendChild(li);
  });
  overlay.classList.remove('hidden');
}

/* ──────────────────────────────────────────────
   18. COACH MEDIA HELPERS
────────────────────────────────────────────── */
function normalizeCoachText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getYouTubeVideoId(url) {
  if (!url) return null;
  const text = String(url).trim();
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.replace('www.', '');
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
      const v = parsed.searchParams.get('v');
      if (v && v.length >= 6) return v;
      if (host === 'youtu.be') { const p = parsed.pathname.replace('/', ''); if (p && p.length >= 6) return p; }
      const segs = parsed.pathname.split('/').filter(Boolean);
      const shorts = segs.indexOf('shorts');
      if (shorts >= 0 && segs[shorts + 1]) return segs[shorts + 1];
      const embed = segs.indexOf('embed');
      if (embed >= 0 && segs[embed + 1]) return segs[embed + 1];
    }
  } catch (_) { }
  const m1 = text.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
  if (m1) return m1[1];
  const m2 = text.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
  if (m2) return m2[1];
  return null;
}

function resolveCoachMediaUrl(url) {
  if (!url) return null;
  const mediaUrl = String(url).trim();
  if (!mediaUrl) return null;

  // Animated GIF or image → display in <img>
  if (/\.(gif|png|jpg|jpeg|webp)(\?.*)?$/i.test(mediaUrl)) {
    return { type: 'image', src: mediaUrl };
  }

  const youtubeId = getYouTubeVideoId(mediaUrl);
  if (youtubeId) {
    return { type: 'embed', src: `https://www.youtube.com/embed/${youtubeId}?autoplay=1&mute=1&playsinline=1&rel=0&loop=1` };
  }

  const vimeo = mediaUrl.match(/vimeo\.com\/(\d+)/);
  if (vimeo) {
    return { type: 'embed', src: `https://player.vimeo.com/video/${vimeo[1]}?autoplay=1&muted=1` };
  }

  if (/\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(mediaUrl)) {
    return { type: 'video', src: mediaUrl };
  }

  if (/^https?:\/\//i.test(mediaUrl)) {
    return { type: 'embed', src: mediaUrl };
  }

  return null;
}

function setCoachLoading(loadingEl, visible) {
  if (loadingEl) loadingEl.classList.toggle('hidden', !visible);
}

function clearCoachMediaSlot(videoEl, gifEl, embedId, loadingEl, fallbackEl) {
  setCoachLoading(loadingEl, false);
  if (videoEl) { videoEl.pause(); videoEl.currentTime = 0; videoEl.removeAttribute('src'); videoEl.classList.add('hidden'); videoEl.load(); }
  if (gifEl) { gifEl.removeAttribute('src'); gifEl.classList.add('hidden'); }
  const embedEl = document.getElementById(embedId);
  if (embedEl) { embedEl.src = 'about:blank'; embedEl.remove(); }
  // Note: we deliberately keep fallbackEl visible if it already has content (mistakes list)
}

function loadCoachMediaSlot(videoEl, gifEl, embedId, loadingEl, fallbackEl, sourceUrl) {
  // Clear previous media but preserve the fallback (mistakes panel) for bad slot
  if (videoEl) { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.classList.add('hidden'); videoEl.load(); }
  if (gifEl) { gifEl.removeAttribute('src'); gifEl.classList.add('hidden'); }
  const existEmbed = document.getElementById(embedId);
  if (existEmbed) { existEmbed.src = 'about:blank'; existEmbed.remove(); }

  if (!sourceUrl) {
    setCoachLoading(loadingEl, false);
    return;
  }

  setCoachLoading(loadingEl, true);
  const resolved = resolveCoachMediaUrl(sourceUrl);

  if (!resolved) {
    setCoachLoading(loadingEl, false);
    return;
  }

  logInfo('media.slot', 'Loading media slot', { type: resolved.type, src: resolved.src.substring(0, 60) });

  if (resolved.type === 'image') {
    // GIF / image demo
    if (!gifEl) { setCoachLoading(loadingEl, false); return; }
    const img = gifEl;
    img.onload = () => { setCoachLoading(loadingEl, false); img.classList.remove('hidden'); if (fallbackEl) fallbackEl.classList.add('hidden'); };
    img.onerror = () => { setCoachLoading(loadingEl, false); img.classList.add('hidden'); };
    img.src = resolved.src;
    return;
  }

  if (resolved.type === 'embed') {
    let embedEl = document.getElementById(embedId);
    if (!embedEl && videoEl && videoEl.parentNode) {
      embedEl = document.createElement('iframe');
      embedEl.id = embedId;
      embedEl.className = 'coach-embed';
      embedEl.setAttribute('allow', 'autoplay; fullscreen');
      embedEl.setAttribute('allowfullscreen', 'true');
      embedEl.src = 'about:blank';
      videoEl.parentNode.insertBefore(embedEl, videoEl.nextSibling);
    }
    if (embedEl) {
      embedEl.onload = () => { setCoachLoading(loadingEl, false); if (fallbackEl) fallbackEl.classList.add('hidden'); };
      embedEl.onerror = () => setCoachLoading(loadingEl, false);
      embedEl.src = resolved.src;
      embedEl.classList.remove('hidden');
    }
    return;
  }

  if (resolved.type === 'video') {
    if (!videoEl) { setCoachLoading(loadingEl, false); return; }
    videoEl.onloadeddata = () => {
      setCoachLoading(loadingEl, false);
      videoEl.classList.remove('hidden');
      if (fallbackEl) fallbackEl.classList.add('hidden');
      const p = videoEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => { });
    };
    videoEl.onerror = () => { setCoachLoading(loadingEl, false); videoEl.classList.add('hidden'); };
    videoEl.src = resolved.src;
    videoEl.load();
  }
}

function updateCoachMistakeList() {
  if (!coachBadMistakesEl) return;
  const tips = WorkoutMistakeTips[workoutKey] || ['Move with full control through the full range.'];
  coachBadMistakesEl.innerHTML = '';
  tips.forEach(tip => {
    const li = document.createElement('li');
    li.textContent = tip;
    coachBadMistakesEl.appendChild(li);
  });
}

/* ──────────────────────────────────────────────
   19a. EDB RAPIDAPI — PRIMARY VIDEO SOURCE
────────────────────────────────────────────── */

/**
 * Returns cached EDB result for a workout key, or null if expired / absent.
 */
function getEdbCache(workout) {
  try {
    const raw = sessionStorage.getItem(`fitlix_edb_${workout}`);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > EDB_CACHE_TTL) { sessionStorage.removeItem(`fitlix_edb_${workout}`); return null; }
    return data;
  } catch (_) { return null; }
}

function setEdbCache(workout, data) {
  try { sessionStorage.setItem(`fitlix_edb_${workout}`, JSON.stringify({ ts: Date.now(), data })); } catch (_) { }
}

/**
 * Fetches exercises from the EDB RapidAPI, picks the best video/GIF for
 * the "Do This" slot and a secondary one for "Avoid This" (different variant).
 * Returns { good, bad, sourceText, isGif } or null on failure.
 */
async function fetchFromEdbApi(workout) {
  // Check cache first
  const cached = getEdbCache(workout);
  if (cached) {
    logInfo('api.edb', 'Cache hit', { workout });
    return cached;
  }

  const searchTerm = EDB_SEARCH_QUERY[workout];
  if (!searchTerm) return null;

  const EDB_HEADERS = {
    'x-rapidapi-key':  EDB_API_KEY,
    'x-rapidapi-host': EDB_API_HOST,
    'Content-Type':    'application/json',
  };

  /** Fetch JSON with timeout; returns null on failure */
  async function edbFetch(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: EDB_HEADERS });
      clearTimeout(tid);
      if (!res.ok) { logWarn('api.edb', `HTTP ${res.status}`, { url }); return null; }
      return await res.json();
    } catch (e) {
      clearTimeout(tid);
      logWarn('api.edb', 'Fetch error', { url, error: String(e) });
      return null;
    }
  }

  try {
    // ── Step 1: Search for exercises matching the workout name ──
    const searchUrl = `${EDB_API_BASE}/exercises/search?search=${encodeURIComponent(searchTerm)}&limit=10`;
    const searchPayload = await edbFetch(searchUrl);
    if (!searchPayload) return null;

    // Response shape: { success, data: [ { exerciseId, name, imageUrl }, ... ] }
    const searchResults = Array.isArray(searchPayload)
      ? searchPayload
      : (Array.isArray(searchPayload.data) ? searchPayload.data : null);

    if (!searchResults || searchResults.length === 0) {
      logWarn('api.edb', 'No search results', { workout });
      return null;
    }

    logInfo('api.edb', `Search returned ${searchResults.length} exercises`, { workout });

    // ── Step 2: Fetch full details for top results to get videoUrl ──
    // Fetch details for up to the first 4 results in parallel
    const detailTargets = searchResults.slice(0, 4);
    const detailPayloads = await Promise.all(
      detailTargets.map(ex =>
        edbFetch(`${EDB_API_BASE}/exercises/${ex.exerciseId}`, 6000)
      )
    );

    // Merge detail data back with search results (fallback to imageUrl if detail failed)
    const enriched = detailTargets.map((ex, i) => {
      const detail = detailPayloads[i];
      const detailData = detail
        ? (detail.data || detail)   // API wraps in { data: {...} } or returns directly
        : null;
      return {
        name:     (detailData?.name || ex.name || '').trim(),
        videoUrl: detailData?.videoUrl || detailData?.video_url || null,
        gifUrl:   detailData?.gifUrl   || detailData?.gif_url   || null,
        imageUrl: detailData?.imageUrl || ex.imageUrl           || null,
      };
    });

    logInfo('api.edb', 'Enriched exercises', { count: enriched.length });

    // ── Step 3: Pick Good ("Do This") and Bad ("Avoid This") slots ──
    // 1. Try to find an exact name match first for the canonical demo
    const exactMatch = enriched.find(ex =>
      normalizeCoachText(ex.name) === normalizeCoachText(searchTerm)
    );

    // Good = exact match OR first entry that has media
    const goodEx = exactMatch || enriched.find(ex => ex.videoUrl || ex.gifUrl || ex.imageUrl);
    if (!goodEx) {
      logWarn('api.edb', 'No media found in enriched results', { workout });
      return null;
    }

    // Bad = a different exercise (different name) that also has media
    const badEx = enriched.find(ex =>
      ex !== goodEx &&
      (ex.videoUrl || ex.gifUrl || ex.imageUrl) &&
      normalizeCoachText(ex.name) !== normalizeCoachText(goodEx.name)
    );

    // Prefer video > gif > image for each slot
    const pickUrl = ex => ex?.videoUrl || ex?.gifUrl || ex?.imageUrl || null;
    const goodUrl = pickUrl(goodEx);
    const badUrl  = pickUrl(badEx);

    const isGif = goodUrl ? /\.(gif)(\?.*)?$/i.test(goodUrl) : false;
    const isVid = goodUrl ? /\.(mp4|webm|mov)(\?.*)?$/i.test(goodUrl) : false;

    const result = {
      good:       goodUrl,
      bad:        badUrl,
      sourceText: `Exercise DB · ${goodEx.name || searchTerm}`,
      isGif:      isGif && !isVid,
    };

    logInfo('api.edb', 'EDB result ready', { good: goodUrl, bad: badUrl });
    setEdbCache(workout, result);
    return result;

  } catch (e) {
    logWarn('api.edb', 'EDB API fetch failed', { error: String(e) });
    return null;
  }
}

/* ──────────────────────────────────────────────
   19b. EXERCISE VIDEO API — EXERCEMUS JSON + FALLBACKS
────────────────────────────────────────────── */
async function fetchFromExercemusJSON(workout) {
  const query = OpenSourceWorkoutQuery[workout] || {};
  const includeTerms = query.include || [workout.replace('_', ' ')];
  const avoidTerms = query.avoid || [];

  for (const feedUrl of OPEN_EXERCISE_FEED_URLS) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(feedUrl, { signal: controller.signal });
      clearTimeout(tid);
      if (!res.ok) continue;

      const exercises = await res.json();
      if (!Array.isArray(exercises) || exercises.length === 0) continue;

      logInfo('api.exercemus', `Loaded ${exercises.length} exercises from feed`, { feedUrl });

      // Find the best matching exercise for "Do This"
      let goodEx = null;
      for (const term of includeTerms) {
        const match = exercises.find(ex => {
          const name = normalizeCoachText(ex.name || ex.id || '');
          return name.includes(term.toLowerCase()) && !avoidTerms.some(a => name.includes(a.toLowerCase()));
        });
        if (match) { goodEx = match; break; }
      }

      if (!goodEx) continue;

      // Find a variant for "Avoid This" (different exercise in same family)
      const badEx = exercises.find(ex => {
        if (!ex || ex.id === goodEx.id) return false;
        const name = normalizeCoachText(ex.name || '');
        return includeTerms.some(t => name.includes(t.toLowerCase())) &&
          !avoidTerms.some(a => name.includes(a.toLowerCase())) &&
          name !== normalizeCoachText(goodEx.name || '');
      });

      // Extract GIF / video URL from the exercise data
      const goodGif = goodEx.gifUrl || goodEx.gif_url || goodEx.animation_url ||
        goodEx.gif || goodEx.image || goodEx.thumbnail || null;
      const badGif = badEx
        ? (badEx.gifUrl || badEx.gif_url || badEx.animation_url || badEx.gif || null)
        : null;

      // Also check for YouTube links in the data
      const goodVideo = goodEx.video || goodEx.videoUrl || goodEx.youtube_url || goodEx.video_url || null;
      const badVideo = badEx
        ? (badEx.video || badEx.videoUrl || badEx.youtube_url || badEx.video_url || null)
        : null;

      // Prefer GIF for seamless looping, fallback to video
      const finalGood = goodGif || goodVideo;
      const finalBad = badGif || badVideo;

      if (finalGood) {
        logInfo('api.exercemus', 'Found exercise media', { good: finalGood, bad: finalBad });
        return {
          good: finalGood,
          bad: finalBad,
          sourceText: 'Exercise Database (Open Source)',
          isGif: Boolean(goodGif),
        };
      }
    } catch (e) {
      logWarn('api.exercemus', `Feed failed: ${feedUrl}`, { error: String(e) });
    }
  }

  return null;
}

async function resolveCoachMediaForWorkout() {
  // 1. Try the EDB RapidAPI (has actual exercise videos/GIFs)
  const edbResult = await fetchFromEdbApi(workoutKey);
  if (edbResult && edbResult.good) {
    logInfo('coach.resolve', 'Using EDB API media', { workout: workoutKey });
    return edbResult;
  }

  // 2. Fall back to Exercemus open-source exercise JSON
  const feedResult = await fetchFromExercemusJSON(workoutKey);
  if (feedResult && feedResult.good) {
    logInfo('coach.resolve', 'Using Exercemus feed media', { workout: workoutKey });
    return feedResult;
  }

  // 3. Last resort: local bundled videos (may not exist)
  logWarn('coach.resolve', 'All API sources failed, using local fallback', { workout: workoutKey });
  const localMedia = LocalCoachVideoMeta[workoutKey] || {};
  return {
    good: localMedia.good || null,
    bad:  localMedia.bad  || null,
    sourceText: localMedia.good ? 'Local bundled media' : null,
    isGif: false,
  };
}

/* ──────────────────────────────────────────────
   20. AI COACH OVERLAY (pose on good-form video)
────────────────────────────────────────────── */
let coachPoseInstance = null;
let coachTrackingActive = false;

function initCoachPose() {
  if (coachPoseInstance) return coachPoseInstance;
  const pose = new window.Pose({
    locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
  });
  pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, enableSegmentation: false, smoothSegmentation: false, minDetectionConfidence: 0.55, minTrackingConfidence: 0.55 });
  pose.onResults((results) => {
    if (!coachTrackingActive) return;
    const canvas = document.getElementById('coach-pose-canvas');
    if (!canvas || !coachGoodVideoEl || coachGoodVideoEl.classList.contains('hidden')) return;
    if (coachGoodVideoEl.videoWidth && canvas.width !== coachGoodVideoEl.videoWidth) {
      canvas.width = coachGoodVideoEl.videoWidth;
      canvas.height = coachGoodVideoEl.videoHeight;
    }
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, canvas.width, canvas.height);
    if (results.poseLandmarks) {
      window.drawConnectors && window.drawConnectors(c, results.poseLandmarks, window.POSE_CONNECTIONS, { color: 'rgba(0,230,118,0.5)', lineWidth: 3 });
      window.drawLandmarks && window.drawLandmarks(c, results.poseLandmarks, { color: '#00E676', lineWidth: 1, radius: 4 });
    }
  });
  coachPoseInstance = pose;
  return pose;
}

function startCoachAI() {
  coachTrackingActive = true;
  const pose = initCoachPose();
  async function trackFrame() {
    if (!coachTrackingActive || !coachGoodVideoEl || coachGoodVideoEl.paused || coachGoodVideoEl.ended) return;
    try {
      // Note: This may fail if the video source has CORS restrictions and we are in a file:/// origin
      await pose.send({ image: coachGoodVideoEl });
    } catch (e) {
      logWarn('coach.ai', 'AI tracking failed on video (likely CORS)', { error: e.message });
      stopCoachAI(); // stop trying to track this video
    }
    if (coachTrackingActive) requestAnimationFrame(trackFrame);
  }
  coachGoodVideoEl.addEventListener('play', () => { if (coachTrackingActive) requestAnimationFrame(trackFrame); });
}

function stopCoachAI() {
  coachTrackingActive = false;
  const canvas = document.getElementById('coach-pose-canvas');
  if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

function setCoachSourceText(text) {
  if (!coachSourceEl) return;
  if (!text) { coachSourceEl.classList.add('hidden'); coachSourceEl.textContent = ''; return; }
  coachSourceEl.classList.remove('hidden');
  coachSourceEl.textContent = text;
}

function pauseCoachVideos() {
  [coachGoodVideoEl, coachBadVideoEl].forEach(v => { if (!v) return; v.pause(); v.currentTime = 0; });
  [coachGoodGifEl, coachBadGifEl].forEach(g => { if (!g) return; g.removeAttribute('src'); g.classList.add('hidden'); });
  [coachGoodEmbedId, coachBadEmbedId].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
}

async function openCoachPreview() {
  if (!coachPreviewEl) return;
  const requestId = ++coachPreviewRequestId;
  coachPreviewTitleEl.textContent = `${meta.name} Form Guide`;
  updateCoachMistakeList();
  coachPreviewEl.classList.remove('hidden');

  // Show loading immediately
  setCoachLoading(coachGoodLoadingEl, true);
  setCoachLoading(coachBadLoadingEl, false);
  setCoachSourceText('Loading exercise demo...');

  const resolvedMedia = await resolveCoachMediaForWorkout();
  if (!coachPreviewEl || coachPreviewEl.classList.contains('hidden') || requestId !== coachPreviewRequestId) return;

  loadCoachMediaSlot(coachGoodVideoEl, coachGoodGifEl, coachGoodEmbedId, coachGoodLoadingEl, coachGoodFallbackEl, resolvedMedia.good || null);
  loadCoachMediaSlot(coachBadVideoEl, coachBadGifEl, coachBadEmbedId, coachBadLoadingEl, coachBadFallbackEl, resolvedMedia.bad || null);
  setCoachSourceText(resolvedMedia.sourceText || null);

  // Start AI overlay on the good-form video if it's a direct video (not GIF/embed)
  if (resolvedMedia.good && !resolvedMedia.isGif) {
    startCoachAI();
  }
}

function closeCoachPreview() {
  if (!coachPreviewEl) return;
  stopCoachAI();
  pauseCoachVideos();
  setCoachLoading(coachGoodLoadingEl, false);
  setCoachLoading(coachBadLoadingEl, false);
  coachPreviewEl.classList.add('hidden');
}

function startWorkoutEngine() {
  if (workoutEngineStarted) return;
  workoutEngineStarted = true;
  try {
    const pose = initPose();
    initCamera(pose);
    sessionStartTime = Date.now();
    setStatus('Ready', 'green');
    showFeedbackToast('Get into position!', 'good');
  } catch (_) {
    workoutEngineStarted = false;
    setStatus('Camera Error', 'red');
    showFeedbackToast('Camera failed — check permissions.', 'bad');
    openCoachPreview();
  }
}

function skipCoachPreview() { closeCoachPreview(); startWorkoutEngine(); }
function startCoachWorkout() { closeCoachPreview(); startWorkoutEngine(); }

/* ──────────────────────────────────────────────
   21. BACK BUTTON
────────────────────────────────────────────── */
function handleBack() {
  if (coachPreviewEl && !coachPreviewEl.classList.contains('hidden')) {
    closeCoachPreview();
    navigateToHome();
    return;
  }
  try {
    if (window.flutter_inappwebview) {
      window.flutter_inappwebview.callHandler('onBackPressed', {});
    } else if (isFileOrigin || rawWorkout) {
      navigateToHome();
    } else {
      history.back();
    }
  } catch (_) {
    rawWorkout ? navigateToHome() : history.back();
  }
}

/* ──────────────────────────────────────────────
   22. ENTRY POINT
────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  try {
    if (!rawWorkout) {
      document.getElementById('loading-screen')?.classList.add('hidden');
      document.getElementById('home-screen')?.classList.remove('hidden');
      return;
    }

    updateRepUI();
    setStatus('Loading…', 'yellow');
    showFeedbackToast('Initializing…', '');

    runLoadingSequence(() => {
      showApp();
      setStatus('Watch Demo', 'yellow');
      showFeedbackToast('Watch the form demo, then start.', 'warn');
      openCoachPreview();
    });
  } catch (error) {
    showFatalBootError(error);
  }
});

/* ──────────────────────────────────────────────
   23. RESIZE + VISIBILITY + CLEANUP
────────────────────────────────────────────── */
window.addEventListener('resize', () => {
  if (videoEl.videoWidth && videoEl.videoHeight) {
    canvasEl.width = videoEl.videoWidth;
    canvasEl.height = videoEl.videoHeight;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && synth) synth.cancel();
});

let sessionStartTime = 0;

function finishWorkout() {
  if (!workoutEngineStarted) { closeCoachPreview(); navigateToHome(); return; }
  if (synth) synth.cancel();

  const payload = {
    workout: workoutKey,
    reps: currentReps,
    duration_sec: Math.round((Date.now() - sessionStartTime) / 1000),
  };

  if (cameraInstance) cameraInstance.stop();
  if (poseInstance) poseInstance.close();
  workoutEngineStarted = false;

  if (window.flutter_inappwebview) {
    try { window.flutter_inappwebview.callHandler('onWorkoutEnded', payload); } catch (e) { }
  } else {
    alert(`Workout Saved!\nExercise: ${meta.name}\nReps: ${payload.reps}\nTime: ${payload.duration_sec}s`);
    navigateToHome();
  }
}