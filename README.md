<div align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/e/e4/MediaPipe_logo.png" width="100" />
  <h1>Fitlix AI Trainer Plugin 🧠⚡</h1>
  <p><strong>Production-grade AI fitness analysis engine in pure Javascript & MediaPipe.</strong><p>
  <br/>
</div>

## 🚀 Overview

The **Fitlix AI Trainer Plugin** is a high-performance, real-time body tracking engine built to be embedded inside the **Fitlix Flutter App** via WebView. It uses true edge-AI to track body position with zero latency, providing users with live rep counts and form correction simply using their mobile camera.

### ✨ What Makes it Special?
* 🎯 **Zero-Latency Edge AI:** Uses MediaPipe Pose to compute 33 skeletal landmarks at 30+ FPS directly on the mobile device. No server uploads. Absolute privacy.
* 📏 **Deep Posture Analyzers:** It doesn't just count reps—it explicitly checks your body alignment, knee tracking, and form depth. 
* 🗣️ **Intelligent Voice Feedback:** The Web Speech API dynamically speaks rep counts so the user never has to look at the screen.
* 📱 **Flutter Optimized:** Designed to be embedded perfectly as a WebView. It handles dynamic resizing safely and communicates smoothly via message handlers.

---

## 🛠 Features

| Feature | Description |
|---|---|
| **Hash & Query Routing** | Initialize dynamic workouts via stable URL hash maps or fallback queries (e.g., `index.html#squat`). |
| **Glassmorphic UI** | Premium iOS-like athletic design with backdrop filters and precise micro-animations handling error states. |
| **Complete Posture AI** | Validates straightness (for Push-Ups/Planks) and proper joint mechanics tracking (for Squats/Lunges). |
| **Anti-Cheat Mechanics** | Minimum rep duration windows and directional strict-angle thresholds prevent spam points. |

## 🏋️‍♂️ Supported Workouts

Call the specific analysis mode by appending the workout key to the file path structure: `index.html#{workoutKey}`

* `pushup` (Push-Up - Tracks back straightness & elbow depth)
* `squat` (Squat - Tracks depth and hip/knee alignment)
* `pullup` (Pull-Up - Tracks arm tension)
* `lunge` (Lunge)
* `situp` (Sit-Up)
* `bicep_curl` (Bicep Curls)
* `shoulder_press` (Shoulder Press)
* `jumping_jack` (Jumping Jacks)

---

## 🔗 Integrating with Flutter

The simplest, cleanest way to bridge this robust engine into your Flutter application is via **`flutter_inappwebview`**.

### 1. Embedded URL Load 
Initialize the controller with the physical static file and pass the workout string to the URL hash dynamically for routing:

```dart
InAppWebView(
  initialUrlRequest: URLRequest(
    // Example: Passing routing dynamically via hash mapping "#pushup"
    url: WebUri("file:///android_asset/flutter_assets/assets/fitlix/index.html#pushup")
  ),
  onWebViewCreated: (controller) {
    // Controller Setup
  },
)
```

> **Note:** If hash routes (`#`) drop in older webviews, you can fallback to standard query parameters (`?workout=pushup`).

### 2. Consuming AI Rep Counts
Listen to the `flutterBridge` to get live data out of the HTML layer as the user completes reps:
```dart
controller.addJavaScriptHandler(
  handlerName: 'flutterBridge',
  callback: (args) {
    final repCount = args[0]['reps'];
    print('User just completed rep number: $repCount');
  }
);
```

### 3. Emulating Native Back Button
The GUI has a software back-button that pushes to a native Dart handler instead of breaking the WebView stack! Just attach this:
```dart
controller.addJavaScriptHandler(
  handlerName: 'onBackPressed',
  callback: (args) {
    Navigator.of(context).pop();
  }
);
```

---

## 🧠 Advanced Posture Correction Engine

In the newest generation of this plugin, we moved past just "counting elbows". Open `script.js` directly to modify the `analyzePosture()` function. 

If a user arches their back during a pushup, the engine detects the loss of the 155-degree straightness line between the **Shoulder (LM: 11)**, **Hip (LM: 23)**, and **Ankle (LM: 27)**. It instantly flags an error and triggers the `shakeAlert` red error micro-animation, urging the user to `"Keep Back Straight!"`.

---

## 🎨 UI & Aesthetics

We've overhauled standard dark mode. The UI is built entirely using:
- **HSL/Hex blending** optimized for contrast.
- **Glassmorphism panels** (`backdrop-filter`) ensuring that dynamic gym lighting behind the user naturally blurs into UI cards.
- **Micro-Animations**, such as the `repFlash` visual pop, explicitly making interactions feel alive.

---

<div align="center">
  <b>Built for Fitlix</b> - Re-envisioning the AI Fitness Ecosystem.
</div>
