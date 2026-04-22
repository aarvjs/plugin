# Fitlix AI Trainer — Context.md

## Product Summary

Fitlix AI Trainer is a real-time, camera-based workout analysis system that runs inside the Fitlix Flutter app using a WebView-based JavaScript engine. Its purpose is to detect human body posture through the device camera, analyze exercise form in real time, count valid repetitions, reject invalid reps, and give instant visual and voice feedback to the user.

This is not a generic fitness content app. It is an interactive AI workout assistant focused on live posture analysis, rep counting, and form correction using on-device pose estimation. The system should feel like a lightweight real-time personal trainer.

The current implementation direction is based on a MediaPipe Pose powered browser engine embedded in Flutter via WebView. The plugin already targets multiple workouts, voice feedback, posture analysis, anti-cheat logic, and Flutter bridge communication. :contentReference[oaicite:0]{index=0}

---

## Core Product Goals

1. Use the mobile camera to track the user’s body in real time.
2. Detect pose landmarks fully on-device with low latency.
3. Count only valid repetitions.
4. Detect incorrect posture and provide immediate corrective feedback.
5. Give clear UI feedback using overlays, labels, animations, and rep indicators.
6. Speak important feedback such as rep count or posture correction through voice.
7. Run inside the Flutter app through WebView without requiring backend inference.
8. Support multiple exercise modes through route-based workout selection. :contentReference[oaicite:1]{index=1}

---

## Primary User Experience

The user opens a workout inside the Fitlix Flutter app.

Before the workout starts:
- The user sees a short coaching preview.
- The preview shows “Do This” and “Avoid This” examples for the selected exercise.
- The preview is skippable.
- If online exercise media is unavailable, the app should use local fallback videos. :contentReference[oaicite:2]{index=2}

When the workout starts:
- The camera opens.
- The pose engine starts detecting the body.
- The system draws a live skeleton or posture overlay.
- The user gets instant feedback:
  - rep count
  - correct / incorrect posture
  - exercise state
  - warning messages
- The system should visually highlight errors when posture is wrong.
- Voice feedback should announce reps and optionally posture corrections. :contentReference[oaicite:3]{index=3}

---

## High-Level Architecture

### 1. Flutter Layer
Flutter is the host application.

Responsibilities:
- Open the AI trainer screen
- Load the HTML/JS trainer inside WebView
- Pass the selected workout mode
- Receive rep counts and status messages from JavaScript
- Handle navigation events such as back press
- Store or display workout results in the native app

Recommended WebView bridge:
- `flutter_inappwebview` :contentReference[oaicite:4]{index=4}

### 2. Web Trainer Layer
This is the embedded HTML/CSS/JavaScript engine loaded inside the WebView.

Responsibilities:
- Access the device camera
- Initialize MediaPipe Pose
- Detect landmarks
- Run workout-specific posture analysis
- Count valid reps
- Reject fake or incomplete reps
- Update UI overlays and warnings
- Trigger voice feedback
- Send events back to Flutter

### 3. Pose Detection Layer
Use MediaPipe Pose for real-time body landmark detection.

Expected behavior:
- 33 body landmarks
- fully on-device
- low latency
- no server upload
- privacy-friendly architecture :contentReference[oaicite:5]{index=5}

---

## Workout Routing

Workout mode is selected using URL hash or query parameter.

Examples:
- `index.html#pushup`
- `index.html#squat`

Fallback:
- `index.html?workout=pushup`

The Web trainer should read the route and initialize the correct workout analyzer. :contentReference[oaicite:6]{index=6}

---

## Supported Workouts

Current supported workout keys:
- `pushup`
- `squat`
- `pullup`
- `lunge`
- `situp`
- `bicep_curl`
- `shoulder_press`
- `jumping_jack` :contentReference[oaicite:7]{index=7}

Each workout must have:
- setup configuration
- landmark usage rules
- rep counting logic
- posture validation logic
- invalid rep rejection logic
- real-time feedback messages

---

## Main Functional Requirements

### A. Camera and Pose Tracking
- Start camera safely inside mobile WebView
- Handle permission errors gracefully
- Start pose detection once video is ready
- Maintain smooth real-time updates
- Handle camera stop / resume safely

### B. Pose Overlay
- Draw body landmarks and connectors on screen
- Show real-time skeleton overlay
- Support visual state changes:
  - normal state
  - correct posture state
  - wrong posture state
- Prefer green for valid posture and red for incorrect posture if visually supported

### C. Rep Counting
- Count only completed reps
- A rep must pass defined angle / depth / state transition rules
- Prevent double-counting
- Reject noisy movement
- Reject partial reps
- Use minimum rep duration windows to block cheating or spam counting :contentReference[oaicite:8]{index=8}

### D. Form Correction
The system must do more than detect motion. It must validate posture quality.

Examples:
- Push-up:
  - detect elbow bend
  - detect body straightness
  - warn if back is not straight
- Squat:
  - detect squat depth
  - detect knee tracking
  - validate body alignment
- Similar posture-specific validation should be added per workout. :contentReference[oaicite:9]{index=9}

### E. Anti-Cheat Logic
The system should not reward fake movement.

Examples:
- too-fast reps should not count
- wrong direction transitions should not count
- incomplete angle range should not count
- unstable jitter should not count

Strict thresholds and directional logic are required. :contentReference[oaicite:10]{index=10}

### F. Voice Feedback
Use browser-based speech synthesis / Web Speech API where supported.

Voice feedback examples:
- “1”
- “2”
- “Keep back straight”
- “Go lower”
- “Good rep”

Voice should be:
- optional if needed
- non-spammy
- rate-limited to avoid repeated nagging :contentReference[oaicite:11]{index=11}

### G. Flutter Communication
The JavaScript layer must send structured data back to Flutter.

Existing bridge example:
- handler name: `flutterBridge`

Example payload ideas:
```json
{
  "type": "rep_update",
  "workout": "pushup",
  "reps": 5,
  "form": "good",
  "message": "Good rep"
}