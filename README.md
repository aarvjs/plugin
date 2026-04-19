# 🧠 Fitlix AI Trainer Plugin

A production-level AI-powered fitness plugin built using **MediaPipe Pose** for real-time workout detection, rep counting, and feedback.

---

## 🚀 Overview

This plugin is designed to work with the Fitlix Flutter app via WebView.
It enables users to perform workouts while the system:

* Tracks body movement in real-time
* Detects posture using AI
* Counts repetitions accurately
* Provides instant feedback

---

## ⚡ How It Works

### 1. Workout Selection (From App)

* User selects a workout inside the Flutter app
* Example:

  * Push-Up
  * Squat
  * Curl

### 2. Dynamic Plugin Launch

* The selected workout is passed via URL:

```
index.html?workout=pushup
```

* The plugin reads this value and loads the corresponding logic dynamically

---

## 🎯 Core Features

### ✅ Real-Time Pose Detection

* Uses **MediaPipe Pose**
* Tracks full body (33 landmarks)
* Draws skeleton overlay on user body

---

### 🎨 Smart Feedback System

* 🟢 **Green** → Correct posture
* 🔴 **Red** → Incorrect posture

Live feedback examples:

* "Good Form"
* "Go Lower"
* "Straighten Body"

---

### 🔁 Accurate Rep Counting

* Detects full motion cycle (DOWN → UP)
* Prevents fake or partial reps
* Ignores random movement

---

### 🔊 Voice Feedback

* Speaks rep count using browser speech API
  Example:

```
"1... 2... 3..."
```

---

### 📊 Data Tracking

* Tracks:

  * Total reps
  * Workout duration
* Sends data to Flutter app via WebView bridge

---

## 🔗 Flutter Integration

The plugin communicates with Flutter using:

```js
window.flutter_inappwebview.callHandler('flutterBridge', {
  reps: currentReps,
  workout: workoutType
});
```

Also exposes:

```
window.reps
```

---

## 🧩 Dynamic Workout System

* No hardcoded workouts
* Fully dynamic based on user selection

Supported structure:

```js
index.html?workout=<type>
```

Examples:

* pushup
* squat
* curl
* lunge

---

## 🧠 AI Logic

* Joint angle calculation
* Movement state tracking (UP/DOWN)
* Confidence-based detection
* Anti-cheat logic (no random counts)

---

## 📱 Performance Optimized

* Smooth camera rendering
* Low-latency detection
* Mobile-friendly (WebView optimized)
* No unnecessary computations

---

## 🎨 UI Design

* Clean and minimal interface
* Live camera with overlay
* Real-time stats card
* Smooth animations

---

## 🛡️ Important Notes

* Session is NOT auto-saved
* Data is saved only when user explicitly clicks **Save**
* Requires camera permission

---

## 🔮 Future Scope

* More workout support
* Advanced posture correction
* AI-based trainer voice assistant
* Personalized workout tracking

---

## 💡 Final Goal

To create a **smart AI fitness experience** where:

* Users can train themselves
* Get real-time guidance
* Improve form and performance
* Track progress automatically

---

🔥 Built as part of **Fitlix – AI Powered Fitness Ecosystem**
