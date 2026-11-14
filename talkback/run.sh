#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner (emulator started with -writable-system). The system image ships
# Google's TalkBack under the same package name, signed with another key and with a higher version, so the build from
# Google's open-source repository cannot be installed over it: the script removes the preinstalled copy from the
# (writable) product partition, installs the build (log level VERBOSE, so every spoken fragment is written to logcat),
# records versions, turns TalkBack on, streams logcat, and drives Chrome with talkback/drive.mjs.
set -uo pipefail
mkdir -p logs transcripts
log() { echo "$*" | tee -a logs/setup.txt; }
booted() { [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; }
boot() {
  adb wait-for-device
  for i in $(seq 1 150); do booted && break; sleep 2; done
  adb root >/dev/null 2>&1 || true
  sleep 3
  adb wait-for-device
  for i in $(seq 1 60); do booted && break; sleep 2; done
  sleep 15
  # "Isn't responding" and crash dialogs off: on a slow runner they take the input focus away from Chrome.
  adb shell settings put global hide_error_dialogs 1 || true
}
HTTP_PID=""
LOGCAT_PID=""
cleanup() {
  [ -n "$LOGCAT_PID" ] && kill "$LOGCAT_PID" 2>/dev/null
  [ -n "$HTTP_PID" ] && kill "$HTTP_PID" 2>/dev/null
  true
}
trap cleanup EXIT

boot
TB=com.google.android.marvin.talkback
APK=$(find apk -name '*.apk' | grep -iv -e wear -e androidTest -e test | head -n1)
log "APK: $APK"
log "preinstalled: $(adb shell pm path $TB | tr -d '\r')"
if adb shell pm path $TB | grep -q 'package:/product/'; then
  log "removing the TalkBack that ships in the system image"
  adb remount 2>&1 | tee -a logs/setup.txt
  adb reboot
  boot
  adb remount 2>&1 | tee -a logs/setup.txt
  adb shell rm -rf /product/app/talkback 2>&1 | tee -a logs/setup.txt
  log "product apps after removal: $(adb shell ls /product/app | tr '\r\n' '  ')"
  adb reboot
  boot
fi
log "before install: $(adb shell pm path $TB | tr -d '\r')"
adb install -r -g "$APK" 2>&1 | tee -a logs/setup.txt
log "after install: $(adb shell pm path $TB | tr -d '\r')"
# No notification prompts over the page (TalkBack and Chrome both ask on first start).
adb shell pm grant $TB android.permission.POST_NOTIFICATIONS 2>&1 | tee -a logs/setup.txt
adb shell pm grant com.android.chrome android.permission.POST_NOTIFICATIONS 2>&1 | tee -a logs/setup.txt
# No on-screen keyboard: the Tab key comes from the emulator's keyboard, and the soft keyboard opening and closing
# adds announcements that are not part of the page.
adb shell ime disable com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME 2>&1 | tee -a logs/setup.txt
log "enabled input methods: $(adb shell ime list -s | tr -d '\r' | tr '\n' ' ')"
{
  echo "fingerprint: $(adb shell getprop ro.build.fingerprint | tr -d '\r')"
  echo "sdk: $(adb shell getprop ro.build.version.sdk | tr -d '\r')"
  echo "talkback package:"; adb shell dumpsys package $TB | grep -m3 -E 'versionName|versionCode|codePath'
  echo "chrome package:"; adb shell pm path com.android.chrome; adb shell dumpsys package com.android.chrome | grep -m1 versionName
  echo "accessibility services:"; adb shell cmd package query-services -a android.accessibilityservice.AccessibilityService --components
  echo "tts services:"; adb shell cmd package query-services -a android.intent.action.TTS_SERVICE --components
  echo "talkback source:"; cat apk/talkback-source.txt 2>/dev/null
} 2>&1 | tee logs/versions.txt
if [ "${TB_SPIKE:-1}" = "1" ]; then
  python3 -m http.server 8000 --directory talkback/fixture >/dev/null 2>&1 &
  HTTP_PID=$!
  sleep 1
fi
adb reverse tcp:8000 tcp:8000 || true
adb logcat -G 16M || true
adb logcat -c
adb logcat -v threadtime > logs/logcat.txt 2>&1 &
LOGCAT_PID=$!
SVC=$TB/com.google.android.marvin.talkback.TalkBackService
adb shell settings put secure enabled_accessibility_services "$SVC"
adb shell settings put secure accessibility_enabled 1
for i in $(seq 1 30); do t=$(adb shell settings get secure touch_exploration_enabled | tr -d '\r'); echo "touch_exploration_enabled=$t"; [ "$t" = "1" ] && break; sleep 2; done 2>&1 | tee -a logs/setup.txt
sleep 8
# TalkBack opens its tutorial the first time it starts; go back to the home screen.
adb shell input keyevent KEYCODE_HOME || true
sleep 3
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
log "focus: $(adb shell dumpsys window | grep -m2 -E 'mCurrentFocus|mFocusedApp' | tr -d '\r' | tr '\n' ' ')"
adb shell dumpsys accessibility > logs/dumpsys-accessibility.txt 2>&1 || true
adb exec-out screencap -p > logs/after-enable.png || true
timeout 9600 node talkback/drive.mjs 2>&1 | tee logs/drive.txt
adb exec-out screencap -p > logs/end.png || true
adb shell dumpsys accessibility > logs/dumpsys-accessibility-end.txt 2>&1 || true
sleep 2
cleanup
log "spoken fragments in logcat: $(grep -c 'Speaking fragment' logs/logcat.txt || true)"
exit 0
