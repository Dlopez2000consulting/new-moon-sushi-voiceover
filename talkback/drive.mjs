// Drives Chrome on the Android emulator through Playwright's Android support while TalkBack is on. For each page:
// (1) a linear read-through with TalkBack's next-item gesture (a one-finger swipe right sent to the emulator), and
// (2) the Tab order with the emulator keyboard after loading the page again, pairing each keyboard focus with what
// TalkBack spoke. TalkBack's speech is read from logcat, where this build logs every spoken fragment; after each
// gesture or key the script waits until TalkBack has finished speaking.
// Live pages: GET only, at most one request per second to the site's own host.
// -> transcripts/<slug>/talkback-transcript.txt and transcripts/<slug>/talkback-summary.json
import { _android as android } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SPIKE = process.env.TB_SPIKE !== '0';
const TABS = Number(process.env.TB_TABS || 20);
const SCALE = Number(process.env.TB_READ_SCALE || 1);
const MODE = process.env.TB_MODE || 'real session on the published site';
const ALL = ['home', 'gallery', 'menu', 'lunch-menu', 'dinner-menu', 'sushi-menu', 'dessert-menu', 'sake-menu', 'contact', 'accessibility', 'sitemap'];
// Linear read-through length per page (the plan of the desktop screen-reader runs); a read stops earlier after eight
// gestures in a row with nothing spoken.
const NEXT = { fixture: 16, home: 70, gallery: 220, menu: 60, 'lunch-menu': 150, 'dinner-menu': 150, 'sushi-menu': 90, 'dessert-menu': 80, 'sake-menu': 120, contact: 60, accessibility: 80, sitemap: 60 };
// TB_MENU=1: one session on Home inside the accessibility menu (Tab to its button, Enter, Tab through the dialog, Escape).
const MENU = process.env.TB_MENU === '1';
const PAGES = MENU ? [{ slug: 'menu-dialog', url: 'https://www.newmoonsushi.com/' }]
  : SPIKE
  ? [{ slug: 'fixture', url: 'http://localhost:8000/index.html' }]
  : (process.env.TB_PAGES || 'all').split(',').map(s => s.trim()).filter(Boolean)
      .flatMap(s => (s === 'all' ? ALL : [s]))
      .map(slug => ({ slug, url: `https://www.newmoonsushi.com/${slug === 'home' ? '' : slug}` }));
const LOGCAT = 'logs/logcat.txt';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- logcat reader (incremental) ----
// 'V talkback: SpeechControllerImpl: Speaking fragment text="...", utteranceId=talkback_12, ...' starts a fragment;
// 'SpeechControllerImpl: Interrupted 11 with talkback_12' marks an utterance cut off by the next one; fragment starts,
// word-range callbacks (onFragmentRangeStarted), and queued items show that TalkBack is still speaking.
let pos = 0, carry = '', pend = null;
const interrupted = new Set();
function pull() {
  const out = { frags: [], activity: 0 };
  let fd;
  try { fd = fs.openSync(LOGCAT, 'r'); } catch { return out; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < pos) pos = 0;
    if (size > pos) {
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      pos = size;
      const lines = (carry + buf.toString('utf8')).split('\n');
      carry = lines.pop();
      for (const raw of lines) {
        const i = raw.indexOf(' talkback: ');
        if (i < 0) continue;
        const msg = raw.slice(i + 11).replace(/\r$/, '');
        if (pend !== null) { // a fragment whose text spans several logcat lines
          pend += ' ' + msg;
          const m = pend.match(/^([\s\S]*?)", utteranceId=(\S+?),/);
          if (m) { out.frags.push({ text: m[1], utt: m[2] }); pend = null; } else if (pend.length > 20000) pend = null;
          out.activity++;
          continue;
        }
        const k = msg.indexOf('Speaking fragment text="');
        if (k >= 0) {
          out.activity++;
          const rest = msg.slice(k + 24);
          const m = rest.match(/^([\s\S]*?)", utteranceId=(\S+?),/);
          if (m) out.frags.push({ text: m[1], utt: m[2] }); else pend = rest;
          continue;
        }
        const m = msg.match(/SpeechControllerImpl: Interrupted (\d+) with /);
        if (m) { interrupted.add('talkback_' + m[1]); continue; }
        if (msg.includes('onFragmentRangeStarted') || msg.includes('Queued speech item')) out.activity++;
      }
    }
  } finally { fs.closeSync(fd); }
  return out;
}

// Waits until TalkBack has finished speaking: at least 0.7 s after the action, then 0.9 s without speech activity
// (2.5 s when nothing was spoken at all); 25 s at most. Returns the fragments spoken meanwhile.
async function settle(maxMs = 25000) {
  const t0 = Date.now(); let last = 0; const frags = [];
  for (;;) {
    await sleep(200);
    const p = pull();
    frags.push(...p.frags);
    const now = Date.now();
    if (p.activity) last = now;
    if (now - t0 >= maxMs) break;
    if (now - t0 < 700) continue;
    if (last ? now - last >= 900 : now - t0 >= 2500) break;
  }
  return frags;
}

// Groups fragments by utterance ("First link" + "link" -> "First link, link"). An utterance that TalkBack cut off and
// started again right away (same first fragment) is shown once.
function utterances(frags) {
  const list = [];
  for (const f of frags) {
    const t = f.text.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    let u = list.find(x => x.utt === f.utt);
    if (!u) { u = { utt: f.utt, parts: [] }; list.push(u); }
    u.parts.push(t);
  }
  return list
    .filter((u, i) => !(interrupted.has(u.utt) && list[i + 1] && list[i + 1].parts[0] === u.parts[0]))
    .map(u => u.parts.join(', ') + (interrupted.has(u.utt) ? ' [cut off]' : ''));
}

const [device] = await android.devices();
if (!device) { console.log('NO DEVICE'); process.exit(0); }
console.log('device', device.model(), device.serial());
const sh = async c => String(await device.shell(c)).trim();
const swipeRight = () => device.shell('input swipe 270 1350 830 1350 300');
const altRight = () => device.shell('input keycombination KEYCODE_ALT_LEFT KEYCODE_DPAD_RIGHT');
const downArrow = () => device.shell('input keyevent 20');
// Keys sent through the emulator console arrive as hardware keyboard events, which TalkBack receives (keys injected
// with "input" from the shell reach the app but not TalkBack's own keyboard commands).
let emuNote = '';
const emu = seq => {
  let out = '';
  try { out = execFileSync('adb', ['-s', device.serial(), 'emu', 'event', 'send', ...seq], { timeout: 15000 }).toString().trim(); } catch (e) { out = 'ERR ' + String(e.stderr || e.message).slice(0, 120); }
  if (!emuNote) { emuNote = out || '(no answer)'; console.log('emu event send:', emuNote); }
};
const SYN = 'EV_SYN:0:0';
const emuDown = async () => emu(['EV_KEY:KEY_DOWN:1', SYN, 'EV_KEY:KEY_DOWN:0', SYN]);
const emuAltRight = async () => emu(['EV_KEY:KEY_LEFTALT:1', SYN, 'EV_KEY:KEY_RIGHT:1', SYN, 'EV_KEY:KEY_RIGHT:0', SYN, 'EV_KEY:KEY_LEFTALT:0', SYN]);
const tabKey = () => device.shell('input keyevent 61');
const ver = await sh('dumpsys package com.android.chrome 2>/dev/null | grep -m1 versionName');
const tbv = await sh('dumpsys package com.google.android.marvin.talkback 2>/dev/null | grep -m1 versionName');
const rel = await sh('getprop ro.build.version.release');
const sdk = await sh('getprop ro.build.version.sdk');
const wm = (await sh('wm size')).replace(/^Physical size:\s*/, '');
let src = '';
try { src = fs.readFileSync('apk/talkback-source.txt', 'utf8').trim().split(' ').slice(0, 2).join(' of '); } catch {}

const context = await device.launchBrowser();
let last = 0;
await context.route(/^https?:\/\/(www\.)?newmoonsushi\.com\//, async route => {
  if (route.request().method() !== 'GET') return route.abort();
  const wait = last + 1000 - Date.now(); last = Math.max(Date.now(), last + 1000);
  if (wait > 0) await sleep(wait);
  return route.continue();
});
const page = context.pages()[0] || await context.newPage();
const focusInfo = () => page.evaluate(() => {
  const e = document.activeElement; if (!e || e === document.body) return '(page body)';
  const name = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return `${e.tagName.toLowerCase()}${e.getAttribute('role') ? `[role=${e.getAttribute('role')}]` : ''}${name ? ` "${name}"` : ''}`;
}).catch(e => `(error: ${String(e).slice(0, 60)})`);
const load = async url => { await page.goto(url, { waitUntil: 'load', timeout: 180000 }); return settle(15000); };

async function linearRead(n, method) {
  const act = { alt: altRight, down: downArrow, swipe: swipeRight, emudown: emuDown, emualt: emuAltRight }[method] || swipeRight;
  const rows = []; let silent = 0, end = `${n} gestures (the planned length)`;
  for (let i = 1; i <= n; i++) {
    await act();
    const fr = await settle();
    rows.push(fr);
    if (fr.length) silent = 0;
    else if (++silent >= 8) { end = 'eight gestures in a row with nothing spoken'; break; }
  }
  return { rows, end };
}
const METHOD_LABEL = { swipe: 'TalkBack next item: one-finger swipe right', alt: 'TalkBack next item: Alt + Right Arrow, injected from the shell', down: 'Down Arrow injected from the shell, TalkBack browse mode', emudown: 'Down Arrow on the emulator keyboard, TalkBack browse mode', emualt: 'TalkBack next item: Alt + Right Arrow on the emulator keyboard' };
let METHOD = process.env.TB_NEXT || 'emudown';

for (const pg of PAGES) {
  const lines = [
    `Screen reader: TalkBack (${tbv || 'version unknown'}; built from Google's open-source repository${src ? `, commit ${src}` : ''})`,
    `Browser: Chrome (${ver || 'version unknown'}), driven through Playwright's Android support`,
    `Device: Android emulator, Pixel 6 profile (${wm}), Android ${rel} (API ${sdk})`,
    `Page: ${pg.url}`,
    `Mode: ${SPIKE ? 'test page served on the runner' : MODE}`,
    `Session date (UTC): ${new Date().toISOString()}`,
    MENU
      ? `Method: on the Home page, the Tab key of the emulator keyboard moves to the accessibility menu button, Enter opens the menu, the Tab key moves through the dialog (24 presses), and Escape closes it; one key at a time after TalkBack finished speaking. TalkBack's spoken text is read from logcat, where this build logs every spoken fragment.`
      : SCALE > 0
      ? `Method: linear reading with TalkBack's next-item command, one command at a time after TalkBack finished speaking; then the Tab order with the Tab key after loading the page again. TalkBack's spoken text is read from logcat, where this build logs every spoken fragment.`
      : `Method: the Tab order with the Tab key of the emulator keyboard, one key at a time after TalkBack finished speaking, from the top of a freshly loaded page. TalkBack's spoken text is read from logcat, where this build logs every spoken fragment. Linear reading with TalkBack's own navigation commands (swipe gestures or keyboard commands) is not included: on the emulator those commands did not move into the web content.`,
    `─`.repeat(56), ''];
  const sum = { slug: pg.slug, url: pg.url, sessionUtc: new Date().toISOString(), method: METHOD, next: null, tabs: null, utterances: 0, error: null };
  const say = fr => { const us = utterances(fr); sum.utterances += us.length; return us; };
  try {
    pull();
    const loaded = await load(pg.url);
    lines.push('### After the page loaded');
    say(loaded).forEach(u => lines.push(`  TalkBack: ${u}`));
    const n = Math.max(1, Math.round((NEXT[pg.slug] || 60) * SCALE));
    const methods = SCALE <= 0 ? [] : SPIKE ? ['emudown', 'emualt'] : [METHOD];
    for (const [mi, method] of methods.entries()) {
      if (mi > 0) { await load(pg.url); }
      let r = await linearRead(n, method);
      lines.push('', `### Linear reading (${METHOD_LABEL[SPIKE ? method : METHOD]})`);
      r.rows.forEach((fr, i) => {
        const us = say(fr);
        lines.push(`Next ${i + 1}:${us.length ? '' : ' (nothing spoken)'}`);
        us.forEach(u => lines.push(`  TalkBack: ${u}`));
      });
      lines.push(`(Read ended after ${r.rows.length} commands: ${r.end}.)`);
      sum.next = { ...(sum.next || {}), [SPIKE ? method : 'read']: { planned: n, done: r.rows.length, spoken: r.rows.filter(x => x.length).length, end: r.end } };
    }
    if (MENU) {
      const dialogOpen = () => page.evaluate(() => { const d = document.getElementById('nms-a11y-dialog'); return !!d && !d.hidden && getComputedStyle(d).display !== 'none' && getComputedStyle(d).visibility !== 'hidden'; }).catch(() => null);
      const expanded = () => page.evaluate(() => document.getElementById('nms-a11y-open')?.getAttribute('aria-expanded')).catch(() => null);
      const rec = (label, fr) => { const us = say(fr); lines.push(label); if (!us.length) lines.push('  TalkBack: (nothing spoken)'); us.forEach(u => lines.push(`  TalkBack: ${u}`)); return us; };
      lines.push('', '### Accessibility menu: Tab to the menu button, open with Enter, Tab through the dialog, close with Escape');
      for (let k = 0; k < 2; k++) { await device.shell('input keyevent 111'); await sleep(600); }
      await sleep(2500); pull(); await settle(6000);
      let tabs = 0, onButton = false;
      while (tabs < 40 && !onButton) {
        await tabKey(); const fr = await settle(); tabs++;
        const f = await focusInfo();
        onButton = await page.evaluate(() => document.activeElement?.id === 'nms-a11y-open').catch(() => false);
        if (onButton) rec(`Tab ${tabs}: keyboard focus ${f} (the menu button; aria-expanded ${await expanded()})`, fr);
      }
      if (!onButton) lines.push(`(The menu button was not reached after ${tabs} Tab presses.)`);
      else {
        await device.shell('input keyevent 66');
        let fr = await settle();
        rec(`Enter: dialog open ${await dialogOpen()}; aria-expanded ${await expanded()}; keyboard focus ${await focusInfo()}`, fr);
        const inDialog = [];
        for (let i = 1; i <= 24; i++) {
          await tabKey(); fr = await settle();
          const f = await focusInfo(); inDialog.push(f);
          rec(`Tab ${i} in the dialog: keyboard focus ${f}`, fr);
        }
        await device.shell('input keyevent 111');
        fr = await settle();
        rec(`Escape: dialog open ${await dialogOpen()}; aria-expanded ${await expanded()}; keyboard focus ${await focusInfo()}`, fr);
        sum.menu = { tabsToButton: tabs, distinctStopsInDialog: new Set(inDialog).size, stops: inDialog };
      }
      throw Object.assign(new Error('menu session complete'), { done: true });
    }
    // Tab order from the top of a freshly loaded page (the page just loaded when there was no linear read).
    if (methods.length) {
      const reloaded = await load(pg.url);
      lines.push('', '### Tab order (Tab key; the page was loaded again first)');
      say(reloaded).forEach(u => lines.push(`  TalkBack (page loaded): ${u}`));
    } else lines.push('', '### Tab order (Tab key)');
    // Chrome's address bar can keep the keyboard focus from an earlier page: Escape returns it to the page.
    for (let k = 0; k < 2; k++) { await device.shell('input keyevent 111'); await sleep(600); }
    await sleep(2500);
    pull(); await settle(6000);
    const stops = []; let outside = 0, done = 0, end = `${TABS} Tab presses (the planned length)`;
    for (let i = 1; i <= TABS; i++) {
      await tabKey();
      const fr = await settle();
      const f = await focusInfo();
      stops.push(f); done = i;
      const us = say(fr);
      lines.push(`Tab ${i}: keyboard focus ${f}`);
      if (!us.length) lines.push('  TalkBack: (nothing spoken)');
      us.forEach(u => lines.push(`  TalkBack: ${u}`));
      // Three presses in a row outside the page: the Tab order has left the page for the browser's own controls.
      if (f === '(page body)') { if (++outside >= 3) { end = 'the Tab order left the page for the browser\'s own controls'; break; } } else outside = 0;
    }
    lines.push(`(Tab walk ended after ${done} presses: ${end}.)`);
    for (let k = 0; k < 2; k++) { await device.shell('input keyevent 111'); await sleep(600); }
    sum.tabs = { done, end, distinctStops: new Set(stops.filter(s => s !== '(page body)')).size, stops };
  } catch (e) {
    if (!e.done) {
      sum.error = String(e).slice(0, 300);
      lines.push(`error: ${sum.error}`);
    }
  }
  const dir = path.join('transcripts', pg.slug); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'talkback-transcript.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'talkback-summary.json'), JSON.stringify(sum, null, 2) + '\n');
  console.log('TRANSCRIPT', pg.slug, lines.length, 'lines', JSON.stringify({ next: sum.next, tabs: sum.tabs && sum.tabs.distinctStops, utterances: sum.utterances, error: sum.error }));
  await sleep(2000);
}
await context.close().catch(() => {});
await device.close().catch(() => {});
console.log('DRIVE-DONE');
