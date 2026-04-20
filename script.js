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
const MIN_GOOD_FORM_FRAMES = 2;        // require stable posture before counting reps
const PHASE_CONFIRM_FRAMES = 2;        // avoid phase flips from single noisy frame
const DOWN_HOLD_MIN_MS = 120;          // minimum time spent in DOWN phase
const THRESHOLD_HYSTERESIS_DEG = 4;    // extra margin before phase switches
const CALIBRATION_MIN_FRAMES = 28;     // auto-personalization warmup
const CALIBRATION_MAX_FRAMES = 120;
const CALIBRATION_MIN_RANGE_DEG = 24;

const INVERTED_WORKOUTS = new Set(['pullup', 'bicep_curl']);
const MIN_REP_RANGE_BY_WORKOUT = {
  pushup: 24,
  squat: 30,
  pullup: 28,
  lunge: 24,
  situp: 28,
  bicep_curl: 30,
  shoulder_press: 34,
  jumping_jack: 26,
};

const WorkoutMeta = {
  pushup: { 
    name: 'Push-Up', icon: '💪', joints: ['elbow', 'body'], primary: 'elbow',
    guide: [
      "Place hands slightly wider than shoulder-width.",
      "Keep your body in a straight line from head to heels. Don't sag your hips.",
      "Lower your body until your chest nearly touches the floor.",
      "Push back up to the starting position."
    ]
  },
  squat: { 
    name: 'Squat', icon: '🏋️', joints: ['knee', 'hip'], primary: 'knee',
    guide: [
      "Stand with feet shoulder-width apart.",
      "Keep your chest up and back straight.",
      "Lower your hips like sitting in a chair until knees are 90 degrees.",
      "Keep your weight on your heels, don't let knees cave in."
    ]
  },
  pullup: { 
    name: 'Pull-Up', icon: '🦾', joints: ['elbow', 'body'], primary: 'elbow',
    guide: [
      "Grip the bar slightly wider than shoulder-width.",
      "Hang completely with arms fully extended.",
      "Pull yourself up until your chin clears the bar.",
      "Lower yourself smoothly back to the start without swinging."
    ]
  },
  lunge: { 
    name: 'Lunge', icon: '🦵', joints: ['knee'], primary: 'knee',
    guide: [
      "Stand tall, step one foot forward.",
      "Lower your body until both knees are bent at a 90-degree angle.",
      "Ensure your front knee doesn't push past your toes.",
      "Push off the front foot to return to the start."
    ]
  },
  situp: { 
    name: 'Sit-Up', icon: '🔥', joints: ['hip'], primary: 'hip',
    guide: [
      "Lie on your back with knees bent and feet flat.",
      "Place fingertips behind your ears or cross arms on chest.",
      "Engage core and lift your upper body off the ground.",
      "Lower your back down with control."
    ]
  },
  bicep_curl: { 
    name: 'Bicep Curl', icon: '💪', joints: ['elbow'], primary: 'elbow',
    guide: [
      "Stand tall holding weights with palms facing forward.",
      "Keep your elbows tucked close to your sides. Don't swing.",
      "Curl the weights up toward your shoulders.",
      "Slowly lower back down to full extension."
    ]
  },
  shoulder_press: { 
    name: 'Shoulder Press', icon: '🏋️', joints: ['elbow'], primary: 'elbow',
    guide: [
      "Hold weights at shoulder height with palms facing out.",
      "Press weights overhead until arms are fully extended.",
      "Do not lock out your elbows completely.",
      "Lower slowly back to shoulder height without leaning back."
    ]
  },
  jumping_jack: { 
    name: 'Jumping Jacks', icon: '⚡', joints: ['arm_spread'], primary: 'arm_spread',
    guide: [
      "Stand upright with legs together and arms at your sides.",
      "Jump up, spreading your legs wider than shoulders.",
      "Swing your arms directly overhead at the same time.",
      "Jump back to the starting position."
    ]
  },
};

const WorkoutVideoMeta = {
  pushup: { good: 'videos/pushup-good.mp4', bad: 'videos/pushup-bad.mp4' },
  squat: { good: 'videos/squat-good.mp4', bad: 'videos/squat-bad.mp4' },
  pullup: { good: 'videos/pullup-good.mp4', bad: 'videos/pullup-bad.mp4' },
  lunge: { good: 'videos/lunge-good.mp4', bad: 'videos/lunge-bad.mp4' },
  situp: { good: 'videos/situp-good.mp4', bad: 'videos/situp-bad.mp4' },
  bicep_curl: { good: 'videos/bicep_curl-good.mp4', bad: 'videos/bicep_curl-bad.mp4' },
  shoulder_press: { good: 'videos/shoulder_press-good.mp4', bad: 'videos/shoulder_press-bad.mp4' },
  jumping_jack: { good: 'videos/jumping_jack-good.mp4', bad: 'videos/jumping_jack-bad.mp4' },
};

// Workout-specific thresholds: [downAngle, upAngle]
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

const SIDE = {
  L: {
    SHOULDER: LM.L_SHOULDER,
    ELBOW: LM.L_ELBOW,
    WRIST: LM.L_WRIST,
    EAR: LM.L_EAR,
    HIP: LM.L_HIP,
    KNEE: LM.L_KNEE,
    ANKLE: LM.L_ANKLE,
    FOOT: LM.L_FOOT_I,
  },
  R: {
    SHOULDER: LM.R_SHOULDER,
    ELBOW: LM.R_ELBOW,
    WRIST: LM.R_WRIST,
    EAR: LM.R_EAR,
    HIP: LM.R_HIP,
    KNEE: LM.R_KNEE,
    ANKLE: LM.R_ANKLE,
    FOOT: LM.R_FOOT_I,
  },
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
let activeThresholds = { ...thresholds };
let calibrationState = {
  done: false,
  frames: 0,
  minAngle: Infinity,
  maxAngle: -Infinity,
};

function selectWorkout(key) {
  window.location.hash = key;
  window.location.reload();
}

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
const coachPreviewEl = document.getElementById('coach-preview');
const coachPreviewTitleEl = document.getElementById('coach-preview-title');
const coachGoodVideoEl = document.getElementById('coach-good-video');
const coachBadVideoEl = document.getElementById('coach-bad-video');
const coachGoodFallbackEl = document.getElementById('coach-good-fallback');
const coachBadFallbackEl = document.getElementById('coach-bad-fallback');

/* ──────────────────────────────────────────────
   3. REP STATE MACHINE
────────────────────────────────────────────── */
let currentReps = 0;
let repPhase = 'UP';      // 'UP' | 'DOWN'
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

function getSidePoint(lm, side, part) {
  return lm[SIDE[side][part]];
}

function visibilityScore(lm, indices) {
  return indices.reduce((sum, idx) => sum + (lm[idx]?.visibility || 0), 0);
}

function pickBestSide(lm, parts, threshold = 0.5) {
  const leftIdx = parts.map((part) => SIDE.L[part]);
  const rightIdx = parts.map((part) => SIDE.R[part]);

  const leftReady = leftIdx.every((idx) => isVisible(lm, idx, threshold));
  const rightReady = rightIdx.every((idx) => isVisible(lm, idx, threshold));

  if (!leftReady && !rightReady) return null;
  if (leftReady && !rightReady) return 'L';
  if (!leftReady && rightReady) return 'R';

  return visibilityScore(lm, leftIdx) >= visibilityScore(lm, rightIdx) ? 'L' : 'R';
}

function torsoLeanFromVertical(lm, side) {
  const shoulder = getSidePoint(lm, side, 'SHOULDER');
  const hip = getSidePoint(lm, side, 'HIP');
  const verticalPoint = { x: hip.x, y: hip.y - 1 };
  return angleBetween(shoulder, hip, verticalPoint);
}

function bodyLineAngle(lm, side) {
  const shoulder = getSidePoint(lm, side, 'SHOULDER');
  const hip = getSidePoint(lm, side, 'HIP');
  const ankle = getSidePoint(lm, side, 'ANKLE');
  return angleBetween(shoulder, hip, ankle);
}

function getAngleSpeed(currentAngle) {
  const now = performance.now();
  if (lastPrimaryAngle === null || !lastPrimaryAngleTs) {
    lastPrimaryAngle = currentAngle;
    lastPrimaryAngleTs = now;
    return 0;
  }

  const dt = (now - lastPrimaryAngleTs) / 1000;
  if (dt <= 0) return 0;

  const speed = Math.abs(currentAngle - lastPrimaryAngle) / dt;
  lastPrimaryAngle = currentAngle;
  lastPrimaryAngleTs = now;
  return speed;
}

function getLungeFrontSide(lm) {
  const leftReady = allVisible(lm, [LM.L_HIP, LM.L_KNEE, LM.L_ANKLE], 0.5);
  const rightReady = allVisible(lm, [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE], 0.5);

  if (!leftReady && !rightReady) return null;
  if (leftReady && !rightReady) return 'L';
  if (!leftReady && rightReady) return 'R';

  const leftKneeAngle = angleBetween(lm[LM.L_HIP], lm[LM.L_KNEE], lm[LM.L_ANKLE]);
  const rightKneeAngle = angleBetween(lm[LM.R_HIP], lm[LM.R_KNEE], lm[LM.R_ANKLE]);
  return leftKneeAngle <= rightKneeAngle ? 'L' : 'R';
}

function getMinRepRange() {
  return MIN_REP_RANGE_BY_WORKOUT[workoutKey] || 22;
}

function resetRepTracking() {
  downFrameStreak = 0;
  upFrameStreak = 0;
  downEnteredAt = 0;
  repMinAngle = Infinity;
  repMaxAngle = -Infinity;
}

function updateThresholdCalibration(angle) {
  if (calibrationState.done || !Number.isFinite(angle)) return;

  calibrationState.frames += 1;
  calibrationState.minAngle = Math.min(calibrationState.minAngle, angle);
  calibrationState.maxAngle = Math.max(calibrationState.maxAngle, angle);

  const range = calibrationState.maxAngle - calibrationState.minAngle;
  const enoughFrames = calibrationState.frames >= CALIBRATION_MIN_FRAMES;
  const shouldFinalize =
    (enoughFrames && range >= CALIBRATION_MIN_RANGE_DEG)
    || calibrationState.frames >= CALIBRATION_MAX_FRAMES;

  if (!shouldFinalize) return;

  // If user barely moved during warmup, keep defaults.
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
    if (up - down < minSpan) {
      const mid = (up + down) / 2;
      down = mid - minSpan / 2;
      up = mid + minSpan / 2;
    }
  } else {
    down = calibrationState.maxAngle - range * 0.25;
    up = calibrationState.minAngle + range * 0.25;
    if (down - up < minSpan) {
      const mid = (down + up) / 2;
      up = mid - minSpan / 2;
      down = mid + minSpan / 2;
    }
  }

  activeThresholds = {
    ...thresholds,
    down: clamp(down, thresholds.down - 24, thresholds.down + 24),
    up: clamp(up, thresholds.up - 24, thresholds.up + 24),
  };
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
    // Changed so it simply relies on the analyzePosture explicit sagging/raising check
    // but remains here as a fallback
    if (angle < 135) return false;
  }
  return true;
}

/* ──────────────────────────────────────────────
   4.5 POSTURE ANALYSIS HELPERS
────────────────────────────────────────────── */
function analyzePosture(lm, primaryAngle, angleSpeedDps = 0) {
  let score = 100;
  let errorMsg = null;

  const markBad = (msg, penalty = 20) => {
    score -= penalty;
    if (!errorMsg) errorMsg = msg;
  };

  switch (workoutKey) {
    case 'pushup': {
      const side = pickBestSide(lm, ['SHOULDER', 'HIP', 'ANKLE', 'WRIST'], 0.5);
      if (!side) {
        markBad('Turn sideways and keep full body in frame.', 50);
        break;
      }

      const shoulder = getSidePoint(lm, side, 'SHOULDER');
      const hip = getSidePoint(lm, side, 'HIP');
      const ankle = getSidePoint(lm, side, 'ANKLE');
      const wrist = getSidePoint(lm, side, 'WRIST');
      const lineAngle = bodyLineAngle(lm, side);

      if (lineAngle < 155) {
        const midY = (shoulder.y + ankle.y) / 2;
        if (hip.y > midY + 0.05) {
          markBad("Don't let your hips sag!", 30);
        } else if (hip.y < midY - 0.05) {
          markBad('Lower your glutes slightly.', 20);
        } else {
          markBad('Keep your back straighter.', 25);
        }
      }

      if (Math.abs(wrist.x - shoulder.x) > 0.3) {
        markBad('Stack wrists under shoulders.', 15);
      }

      if (angleSpeedDps > 260) {
        markBad('Move slower for controlled reps.', 10);
      }
      break;
    }

    case 'pullup': {
      const side = pickBestSide(lm, ['SHOULDER', 'HIP', 'ANKLE', 'ELBOW'], 0.5);
      if (!side) {
        markBad('Keep your side profile visible in frame.', 45);
        break;
      }

      if (bodyLineAngle(lm, side) < 145) {
        markBad('Avoid kipping. Keep your body tighter.', 30);
      }

      if (angleSpeedDps > 320) {
        markBad('Control the descent; avoid swinging.', 12);
      }
      break;
    }

    case 'squat': {
      const side = pickBestSide(lm, ['SHOULDER', 'HIP', 'KNEE', 'ANKLE'], 0.5);
      if (!side) {
        markBad('Show side profile for accurate squat coaching.', 45);
        break;
      }

      if (torsoLeanFromVertical(lm, side) > 48 && primaryAngle < 150) {
        markBad('Keep your chest up and spine neutral.', 25);
      }

      const knee = getSidePoint(lm, side, 'KNEE');
      const ankle = getSidePoint(lm, side, 'ANKLE');
      if (Math.abs(knee.x - ankle.x) > 0.18 && primaryAngle < 140) {
        markBad('Keep knees stacked over feet.', 15);
      }

      if (allVisible(lm, [LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE], 0.5) && primaryAngle < 140) {
        const kneeGap = Math.abs(lm[LM.L_KNEE].x - lm[LM.R_KNEE].x);
        const ankleGap = Math.abs(lm[LM.L_ANKLE].x - lm[LM.R_ANKLE].x);
        if (ankleGap > 0.04 && kneeGap < ankleGap * 0.65) {
          markBad("Don't let your knees cave in.", 25);
        }
      }

      if (angleSpeedDps > 240) {
        markBad('Lower with more control.', 10);
      }
      break;
    }

    case 'lunge': {
      const frontSide = getLungeFrontSide(lm);
      if (!frontSide) {
        markBad('Keep both legs visible for lunge analysis.', 45);
        break;
      }

      if (torsoLeanFromVertical(lm, frontSide) > 40 && primaryAngle < 150) {
        markBad('Keep your torso upright.', 25);
      }

      const frontKnee = getSidePoint(lm, frontSide, 'KNEE');
      const frontAnkle = getSidePoint(lm, frontSide, 'ANKLE');
      if (Math.abs(frontKnee.x - frontAnkle.x) > 0.18 && primaryAngle < 145) {
        markBad('Front knee should stay over front foot.', 20);
      }
      break;
    }

    case 'situp': {
      const side = pickBestSide(lm, ['SHOULDER', 'HIP', 'KNEE'], 0.5);
      if (!side) {
        markBad('Keep your torso and knees inside the frame.', 40);
        break;
      }

      if (angleSpeedDps > 280) {
        markBad('Avoid jerking. Lift with core control.', 25);
      }

      if (allVisible(lm, [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP], 0.5)) {
        const shoulderTilt = Math.abs(lm[LM.L_SHOULDER].y - lm[LM.R_SHOULDER].y);
        if (shoulderTilt > 0.13) {
          markBad('Avoid twisting your torso during sit-ups.', 15);
        }
      }
      break;
    }

    case 'bicep_curl': {
      const side = pickBestSide(lm, ['SHOULDER', 'ELBOW', 'WRIST', 'HIP'], 0.5);
      if (!side) {
        markBad('Show your full upper body in frame.', 40);
        break;
      }

      const shoulder = getSidePoint(lm, side, 'SHOULDER');
      const elbow = getSidePoint(lm, side, 'ELBOW');
      if (Math.abs(elbow.x - shoulder.x) > 0.1) {
        markBad('Keep elbows tucked to your sides.', 25);
      }

      if (torsoLeanFromVertical(lm, side) > 25) {
        markBad("Don't swing your torso.", 20);
      }

      if (angleSpeedDps > 260) {
        markBad('Lower the weight with control.', 12);
      }
      break;
    }

    case 'shoulder_press': {
      const side = pickBestSide(lm, ['SHOULDER', 'ELBOW', 'WRIST', 'HIP', 'KNEE'], 0.5);
      if (!side) {
        markBad('Keep your side profile visible for shoulder press.', 40);
        break;
      }

      const shoulder = getSidePoint(lm, side, 'SHOULDER');
      const wrist = getSidePoint(lm, side, 'WRIST');
      const hip = getSidePoint(lm, side, 'HIP');
      const knee = getSidePoint(lm, side, 'KNEE');
      const backAngle = angleBetween(shoulder, hip, knee);

      if (backAngle < 150 && primaryAngle > 120) {
        markBad('Brace your core. Avoid lower-back arch.', 25);
      }

      if (primaryAngle > 145 && Math.abs(wrist.x - shoulder.x) > 0.16) {
        markBad('Stack wrists above shoulders at the top.', 20);
      }

      if (angleSpeedDps > 280) {
        markBad('Press smoothly. Avoid bouncing.', 10);
      }
      break;
    }

    case 'jumping_jack': {
      const needs = [
        LM.L_SHOULDER, LM.R_SHOULDER,
        LM.L_HIP, LM.R_HIP,
        LM.L_WRIST, LM.R_WRIST,
        LM.L_KNEE, LM.R_KNEE,
        LM.L_ANKLE, LM.R_ANKLE,
      ];
      if (!allVisible(lm, needs, 0.5)) {
        markBad('Keep your full body centered in frame.', 50);
        break;
      }

      const leftArmLift = angleBetween(lm[LM.L_WRIST], lm[LM.L_SHOULDER], lm[LM.L_HIP]);
      const rightArmLift = angleBetween(lm[LM.R_WRIST], lm[LM.R_SHOULDER], lm[LM.R_HIP]);
      if (Math.abs(leftArmLift - rightArmLift) > 25) {
        markBad('Move both arms evenly.', 20);
      }

      const kneeGap = Math.abs(lm[LM.L_KNEE].x - lm[LM.R_KNEE].x);
      const ankleGap = Math.abs(lm[LM.L_ANKLE].x - lm[LM.R_ANKLE].x);
      if (ankleGap > 0.24 && kneeGap < ankleGap * 0.6) {
        markBad("Don't let knees collapse inward.", 25);
      }
      break;
    }

    default:
      break;
  }

  const isOk = score >= 70;
  return { isOk, errorMsg: isOk ? null : (errorMsg || 'Adjust posture.'), score };
}

/* ──────────────────────────────────────────────
   5. WORKOUT-SPECIFIC ANGLE EXTRACTORS
────────────────────────────────────────────── */
function getPrimaryAngle(lm) {
  switch (workoutKey) {

    case 'pushup':
    case 'pullup':
    case 'bicep_curl':
    case 'shoulder_press': {
      const side = pickBestSide(lm, ['SHOULDER', 'ELBOW', 'WRIST'], 0.5);
      if (!side) return null;
      return angleBetween(
        getSidePoint(lm, side, 'SHOULDER'),
        getSidePoint(lm, side, 'ELBOW'),
        getSidePoint(lm, side, 'WRIST')
      );
    }

    case 'squat': {
      const side = pickBestSide(lm, ['HIP', 'KNEE', 'ANKLE'], 0.5);
      if (!side) return null;
      return angleBetween(
        getSidePoint(lm, side, 'HIP'),
        getSidePoint(lm, side, 'KNEE'),
        getSidePoint(lm, side, 'ANKLE')
      );
    }

    case 'lunge': {
      const frontSide = getLungeFrontSide(lm);
      if (!frontSide) return null;
      return angleBetween(
        getSidePoint(lm, frontSide, 'HIP'),
        getSidePoint(lm, frontSide, 'KNEE'),
        getSidePoint(lm, frontSide, 'ANKLE')
      );
    }

    case 'situp': {
      const side = pickBestSide(lm, ['SHOULDER', 'HIP', 'KNEE'], 0.5);
      if (!side) return null;
      return angleBetween(
        getSidePoint(lm, side, 'SHOULDER'),
        getSidePoint(lm, side, 'HIP'),
        getSidePoint(lm, side, 'KNEE')
      );
    }

    case 'jumping_jack': {
      const needs = [LM.L_WRIST, LM.L_SHOULDER, LM.L_HIP, LM.R_WRIST, LM.R_SHOULDER, LM.R_HIP];
      if (!allVisible(lm, needs, 0.5)) return null;
      const left = angleBetween(lm[LM.L_WRIST], lm[LM.L_SHOULDER], lm[LM.L_HIP]);
      const right = angleBetween(lm[LM.R_WRIST], lm[LM.R_SHOULDER], lm[LM.R_HIP]);
      return (left + right) / 2;
    }

    default:
      return null;
  }
}

/* ──────────────────────────────────────────────
   6. REP COUNTING LOGIC
────────────────────────────────────────────── */
function processRep(rawAngle, formIsGood = true) {
  const angle = smoothAngle('primary', rawAngle);
  if (!formIsGood) {
    downFrameStreak = 0;
    upFrameStreak = 0;
    return { counted: false, angle };
  }

  const now = Date.now();
  const { down, up } = activeThresholds;
  const inverted = INVERTED_WORKOUTS.has(workoutKey);

  const downEnter = inverted
    ? angle >= (down + THRESHOLD_HYSTERESIS_DEG)
    : angle <= (down - THRESHOLD_HYSTERESIS_DEG);
  const upEnter = inverted
    ? angle <= (up - THRESHOLD_HYSTERESIS_DEG)
    : angle >= (up + THRESHOLD_HYSTERESIS_DEG);

  if (repPhase === 'UP') {
    upFrameStreak = 0;
    downFrameStreak = downEnter ? (downFrameStreak + 1) : 0;
    if (downFrameStreak >= PHASE_CONFIRM_FRAMES) {
      repPhase = 'DOWN';
      downEnteredAt = now;
      repMinAngle = angle;
      repMaxAngle = angle;
      downFrameStreak = 0;
    }
    return { counted: false, angle };
  }

  // Rep is in DOWN phase
  repMinAngle = Math.min(repMinAngle, angle);
  repMaxAngle = Math.max(repMaxAngle, angle);

  downFrameStreak = 0;
  upFrameStreak = upEnter ? (upFrameStreak + 1) : 0;
  if (upFrameStreak >= PHASE_CONFIRM_FRAMES) {
    const elapsed = now - lastRepTime;
    const downHold = now - downEnteredAt;
    const repRange = repMaxAngle - repMinAngle;
    const enoughRange = repRange >= getMinRepRange();

    repPhase = 'UP';
    upFrameStreak = 0;
    repMinAngle = Infinity;
    repMaxAngle = -Infinity;

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
   7. FEEDBACK LOGIC
────────────────────────────────────────────── */
function getFeedback(angle, postureInfo) {
  if (!postureInfo.isOk) return { msg: postureInfo.errorMsg || 'Adjust Pose', cls: 'bad' };

  const { down, up } = activeThresholds;
  const inverted = INVERTED_WORKOUTS.has(workoutKey);

  if (repPhase === 'UP') {
    // Expect the user to go down
    const halfwayDown = inverted
      ? (angle >= (up + (down - up) * 0.45))
      : (angle <= (up - (up - down) * 0.45));
    if (halfwayDown) return { msg: activeThresholds.downLabel, cls: 'warn' };
    return { msg: 'Good Form', cls: 'good' };
  } else {
    // User is in DOWN phase — expect them to push up
    return { msg: activeThresholds.upLabel, cls: 'warn' };
  }
}

/* ──────────────────────────────────────────────
   8. VOICE FEEDBACK
────────────────────────────────────────────── */
const synth = window.speechSynthesis;
let isSpeaking = false;

function speakMsg(text, isUrgent = false) {
  if (!synth) return;
  if (isSpeaking && !isUrgent) return; // If urgent, override
  
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.1;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;
  utterance.onstart = () => { isSpeaking = true; };
  utterance.onend = () => { isSpeaking = false; };
  
  if (isUrgent) synth.cancel(); // Cancel current to shout the rep or critical error
  synth.speak(utterance);
}

function speakRep(count) {
  speakMsg(String(count), true);
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

  // Sync canvas accurately to the true video resolution to avoid alignment drifting
  if (videoEl.videoWidth && videoEl.videoHeight) {
    if (canvasEl.width !== videoEl.videoWidth || canvasEl.height !== videoEl.videoHeight) {
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
    }
  }

  const lm = results.poseLandmarks;

  if (!lm || lm.length === 0) {
    goodFormStreak = 0;
    lastPrimaryAngle = null;
    lastPrimaryAngleTs = 0;
    repPhase = 'UP';
    resetRepTracking();
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    showFrameAlert(true);
    setStatus('No Pose', 'red');
    return;
  }

  const poseVisible = checkPoseVisible(lm);
  showFrameAlert(!poseVisible);

  if (!poseVisible) {
    goodFormStreak = 0;
    repPhase = 'UP';
    resetRepTracking();
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
    lastPrimaryAngle = null;
    lastPrimaryAngleTs = 0;
    resetRepTracking();
    drawSkeleton(lm, '#FFD600');
    setStatus('Adjust Pose', 'yellow');
    return;
  }

  updateThresholdCalibration(rawAngle);

  const angleSpeedDps = getAngleSpeed(rawAngle);

  // Posture Analysis
  const postureInfo = analyzePosture(lm, rawAngle, angleSpeedDps);
  const bodyOk = postureInfo.isOk;
  if (bodyOk) {
    goodFormStreak = Math.min(goodFormStreak + 1, MIN_GOOD_FORM_FRAMES + 4);
  } else {
    goodFormStreak = 0;
  }

  // Count reps only when posture is stable for a couple of frames
  const repAllowed = bodyOk && goodFormStreak >= MIN_GOOD_FORM_FRAMES;
  const { counted, angle } = processRep(rawAngle, repAllowed);
  lastAngle = angle;

  if (counted) {
    updateRepUI(true);
    speakRep(currentReps);
    sendToFlutter(currentReps);
  }

  lastPoseOk = bodyOk && poseVisible;
  lastPoseColor = lastPoseOk ? '#00E676' : '#FF1744';

  drawSkeleton(lm, lastPoseColor);
  updateAngleUI(angle, bodyOk);

  // Status
  if (!bodyOk) {
    setStatus('Fix Form', 'red');
  } else if (!calibrationState.done) {
    setStatus('Learning Range', 'yellow');
  } else if (!repAllowed) {
    setStatus('Hold Form', 'yellow');
  } else if (repPhase === 'DOWN') {
    setStatus(activeThresholds.upLabel, 'yellow');
  } else {
    setStatus('Good Form', 'green');
  }

  // Feedback toast throttle
  const now = Date.now();
  if (now - lastFeedbackTime > FEEDBACK_THROTTLE_MS) {
    const fb = getFeedback(angle, postureInfo);
    showFeedbackToast(fb.msg, fb.cls);
    if (fb.cls === 'bad' || fb.cls === 'warn') {
       speakMsg(fb.msg, false); // Speak the form correction naturally
    }
    lastFeedbackTime = now;
  }
}

/* ──────────────────────────────────────────────
   14. MEDIAPIPE POSE INITIALIZATION
────────────────────────────────────────────── */
let poseInstance = null;
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
  poseInstance = pose;
  return pose;
}

/* ──────────────────────────────────────────────
   15. CAMERA INITIALIZATION
────────────────────────────────────────────── */
let cameraInstance = null;
function initCamera(pose) {
  const camera = new Camera(videoEl, {
    onFrame: async () => {
      await pose.send({ image: videoEl });
    },
    width: 640,  // Lowered resolution guarantees 30+FPS on old phones
    height: 480,
    facingMode: 'user',
  });
  cameraInstance = camera;
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
   17. GUIDE LOGIC
────────────────────────────────────────────── */
function toggleGuide() {
  const overlay = document.getElementById('guide-overlay');
  
  if (!overlay.classList.contains('hidden')) {
    overlay.classList.add('hidden');
    return;
  }
  
  // Populate guide data before showing
  document.getElementById('guide-title').textContent = meta.name;
  document.getElementById('guide-icon').textContent = meta.icon;
  
  const list = document.getElementById('guide-list');
  list.innerHTML = '';
  
  if (meta.guide && meta.guide.length > 0) {
    meta.guide.forEach(step => {
      const li = document.createElement('li');
      li.textContent = step;
      list.appendChild(li);
    });
  } else {
    const li = document.createElement('li');
    li.textContent = "Maintain good form and follow the app's audio/visual cues.";
    list.appendChild(li);
  }
  
  overlay.classList.remove('hidden');
}

function loadCoachVideo(videoEl, fallbackEl, sourcePath, fallbackLabel) {
  if (!videoEl || !fallbackEl) return;

  if (!sourcePath) {
    videoEl.classList.add('hidden');
    fallbackEl.classList.remove('hidden');
    fallbackEl.textContent = `${fallbackLabel} video is not configured.`;
    return;
  }

  fallbackEl.textContent = `Missing file: ${sourcePath}`;
  videoEl.classList.remove('hidden');
  fallbackEl.classList.add('hidden');

  videoEl.onloadeddata = () => {
    videoEl.classList.remove('hidden');
    fallbackEl.classList.add('hidden');
    const playPromise = videoEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => { });
    }
  };

  videoEl.onerror = () => {
    videoEl.classList.add('hidden');
    fallbackEl.classList.remove('hidden');
  };

  videoEl.src = sourcePath;
  videoEl.load();
}

function pauseCoachVideos() {
  [coachGoodVideoEl, coachBadVideoEl].forEach((video) => {
    if (!video) return;
    video.pause();
  });
}

function openCoachPreview() {
  if (!coachPreviewEl) return;

  const videoMeta = WorkoutVideoMeta[workoutKey] || {};
  coachPreviewTitleEl.textContent = `${meta.name} Form Guide`;

  loadCoachVideo(coachGoodVideoEl, coachGoodFallbackEl, videoMeta.good, 'Good-form');
  loadCoachVideo(coachBadVideoEl, coachBadFallbackEl, videoMeta.bad, 'Bad-form');

  coachPreviewEl.classList.remove('hidden');
}

function closeCoachPreview() {
  if (!coachPreviewEl) return;
  pauseCoachVideos();
  coachPreviewEl.classList.add('hidden');
}

function startWorkoutEngine() {
  if (workoutEngineStarted) return;
  workoutEngineStarted = true;

  const pose = initPose();
  initCamera(pose);
  sessionStartTime = Date.now();
  setStatus('Ready', 'green');
  showFeedbackToast('Get into position!', 'good');
}

function skipCoachPreview() {
  closeCoachPreview();
  startWorkoutEngine();
}

function startCoachWorkout() {
  closeCoachPreview();
  startWorkoutEngine();
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
    if (rawWorkout) {
        window.location.hash = '';
        window.location.search = '';
        window.location.reload();
    } else {
        history.back();
    }
  }
}

/* ──────────────────────────────────────────────
   18. ENTRY POINT
────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  if (!rawWorkout) {
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('home-screen').classList.remove('hidden');
    return; // Wait for user to select from home screen
  }

  // Initial UI state
  updateRepUI();
  setStatus('Loading…', 'yellow');
  showFeedbackToast('Initializing…', '');

  runLoadingSequence(() => {
    showApp();
    setStatus('Watch Demo', 'yellow');
    showFeedbackToast('Watch form preview, then start.', 'warn');
    openCoachPreview();
  });
});

/* ──────────────────────────────────────────────
   19. RESIZE HANDLER — canvas stays in sync
────────────────────────────────────────────── */
window.addEventListener('resize', () => {
  if (videoEl.videoWidth && videoEl.videoHeight) {
    canvasEl.width = videoEl.videoWidth;
    canvasEl.height = videoEl.videoHeight;
  }
});

/* ──────────────────────────────────────────────
   20. VISIBILITY & CLEANUP HANDLERS
────────────────────────────────────────────── */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    synth && synth.cancel();
  }
});

let sessionStartTime = 0;

function finishWorkout() {
  if (!workoutEngineStarted) {
    closeCoachPreview();
    window.location.hash = '';
    window.location.search = '';
    window.location.reload();
    return;
  }

  if (synth) synth.cancel();
  
  const payload = {
    workout: workoutKey,
    reps: currentReps,
    duration_sec: Math.round((Date.now() - sessionStartTime) / 1000)
  };
  
  // Crucial: Stop camera to prevent background battery drain
  if (cameraInstance) {
    cameraInstance.stop();
  }
  if (poseInstance) {
    poseInstance.close();
  }
  workoutEngineStarted = false;
  
  // Sync to Backend / WebView Controller
  if (window.flutter_inappwebview) {
    try {
      window.flutter_inappwebview.callHandler('onWorkoutEnded', payload);
    } catch(e) {}
  } else {
    // Pure Web Fallback
    console.log("Syncing payload to backend:", JSON.stringify(payload));
    alert("Workout Saved!\nReps: " + payload.reps + "\nTime: " + payload.duration_sec + "s\nCheck console for JSON payload.");
    
    // Send standard fetch to API (e.g. your Node.js or Go server)
    /*
    fetch('/api/sync-workout', {
       method: 'POST', body: JSON.stringify(payload)
    });
    */
    
    window.location.hash = '';
    window.location.search = '';
    window.location.reload();
  }
}
