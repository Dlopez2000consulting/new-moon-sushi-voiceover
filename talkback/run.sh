#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner: installs the TalkBack build, records versions, turns TalkBack on,
# streams logcat (TalkBack logs every spoken fragment at VERBOSE), and drives Chrome with talkback/drive.mjs.
set -uo pipefail
mkdir -p logs transcripts
adb wait-for-device
adb root || true
adb wait-for-device
for i in $(seq 1 90); do [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ] && break; sleep 2; done
sleep 5
APK=$(find apk -name '*.apk' | grep -iv -e wear -e androidTest -e test | head -n1)
echo "APK: $APK" | tee logs/setup.txt
find apk -name '*.apk' | tee -a logs/setup.txt
adb install -r -g "$APK" 2>&1 | tee -a logs/setup.txt
{
  echo "fingerprint: $(adb shell getprop ro.build.fingerprint | tr -d '\r')"
  echo "sdk: $(adb shell getprop ro.build.version.sdk | tr -d '\r')"
  echo "talkback package:"; adb shell dumpsys package com.google.android.marvin.talkback | grep -m3 -E 'versionName|versionCode|codePath'
  echo "chrome package:"; adb shell pm path com.android.chrome; adb shell dumpsys package com.android.chrome | grep -m1 versionName
  echo "accessibility services:"; adb shell cmd package query-services -a android.accessibilityservice.AccessibilityService --components
  echo "tts services:"; adb shell cmd package query-services -a android.intent.action.TTS_SERVICE --components
  echo "talkback source:"; cat apk/talkback-source.txt 2>/dev/null
} 2>&1 | tee logs/versions.txt
if [ "${TB_SPIKE:-1}" = "1" ]; then
  (cd talkback/fixture && nohup python3 -m http.server 8000 >/dev/null 2>&1 &)
  sleep 1
  adb reverse tcp:8000 tcp:8000
fi
adb logcat -G 16M || true
adb logcat -c
nohup adb logcat -v threadtime > logs/logcat.txt 2>&1 &
LOGCAT_PID=$!
SVC=com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService
adb shell settings put secure enabled_accessibility_services "$SVC"
adb shell settings put secure accessibility_enabled 1
for i in $(seq 1 30); do t=$(adb shell settings get secure touch_exploration_enabled | tr -d '\r'); echo "touch_exploration_enabled=$t"; [ "$t" = "1" ] && break; sleep 2; done 2>&1 | tee -a logs/setup.txt
sleep 5
adb shell dumpsys accessibility > logs/dumpsys-accessibility.txt 2>&1 || true
adb exec-out screencap -p > logs/after-enable.png || true
node talkback/drive.mjs 2>&1 | tee logs/drive.txt
adb exec-out screencap -p > logs/end.png || true
adb shell dumpsys accessibility > logs/dumpsys-accessibility-end.txt 2>&1 || true
sleep 2
kill "$LOGCAT_PID" 2>/dev/null || true
echo "spoken fragments in logcat: $(grep -c 'Speaking fragment' logs/logcat.txt || true)" | tee -a logs/setup.txt
exit 0
