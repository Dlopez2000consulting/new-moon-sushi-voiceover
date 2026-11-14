// Drives Chrome on the Android emulator through Playwright's Android support while TalkBack is on, presses Tab with the
// emulator keyboard, and pairs each keyboard focus with the phrases TalkBack spoke (read from logcat, where TalkBack
// logs every spoken fragment at VERBOSE). Live pages: GET only, at most one request per second to the site's own host.
// -> transcripts/<slug>/talkback-transcript.txt
import { _android as android } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const SPIKE = process.env.TB_SPIKE !== '0';
const TABS = Number(process.env.TB_TABS || 40);
const PAGES = SPIKE
  ? [{ slug: 'fixture', url: 'http://localhost:8000/index.html' }]
  : (process.env.TB_PAGES || 'home').split(',').map(s => s.trim()).filter(Boolean)
      .map(slug => ({ slug, url: `https://www.newmoonsushi.com/${slug === 'home' ? '' : slug}` }));
const LOGCAT = 'logs/logcat.txt';
const readLog = () => { try { return fs.readFileSync(LOGCAT, 'utf8'); } catch { return ''; } };
// TalkBack: "talkback: SpeechControllerImpl: Speaking fragment text="...", utteranceId=..."
const spoken = text => [...text.matchAll(/Speaking fragment text="([\s\S]*?)", utteranceId=/g)].map(m => m[1].replace(/\s+/g, ' ').trim());
const sleep = ms => new Promise(r => setTimeout(r, ms));

const [device] = await android.devices();
if (!device) { console.log('NO DEVICE'); process.exit(0); }
console.log('device', device.model(), device.serial());
const context = await device.launchBrowser();
let last = 0;
await context.route(/^https?:\/\/(www\.)?newmoonsushi\.com\//, async route => {
  if (route.request().method() !== 'GET') return route.abort();
  const wait = last + 1000 - Date.now(); last = Math.max(Date.now(), last + 1000);
  if (wait > 0) await sleep(wait);
  return route.continue();
});
const page = context.pages()[0] || await context.newPage();
const ver = String(await device.shell('dumpsys package com.android.chrome | grep -m1 versionName')).trim();
const tbv = String(await device.shell('dumpsys package com.google.android.marvin.talkback | grep -m1 versionName')).trim();
const focusInfo = () => page.evaluate(() => {
  const e = document.activeElement; if (!e || e === document.body) return '(page body)';
  const name = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return `${e.tagName.toLowerCase()}${e.getAttribute('role') ? `[role=${e.getAttribute('role')}]` : ''}${name ? ` "${name}"` : ''}`;
}).catch(e => `(error: ${String(e).slice(0, 60)})`);

for (const pg of PAGES) {
  const lines = [
    `Screen reader: TalkBack (${tbv || 'version unknown'}; Google open-source build) on an Android emulator`,
    `Browser: Chrome (${ver || 'version unknown'}), driven through Playwright's Android support`,
    `Page: ${pg.url}`,
    `Session date (UTC): ${new Date().toISOString()}`,
    `Method: Tab key sent to the emulator; TalkBack's spoken text read from logcat after each Tab.`,
    `────────────────────────────────────────────────────────`, ''];
  try {
    await page.goto(pg.url, { waitUntil: 'load', timeout: 120000 });
    await sleep(6000);
    let seen = spoken(readLog()).length;
    lines.push(`### After the page loaded`);
    spoken(readLog()).slice(-8).forEach(s => lines.push(`  TalkBack: ${s}`));
    lines.push('', `### Tab order (Tab key)`);
    for (let i = 1; i <= TABS; i++) {
      await device.shell('input keyevent 61');
      await sleep(1800);
      const all = spoken(readLog()); const fresh = all.slice(seen); seen = all.length;
      lines.push(`Tab ${i}: keyboard focus ${await focusInfo()}`);
      if (!fresh.length) lines.push('  TalkBack: (nothing new spoken)');
      fresh.forEach(s => lines.push(`  TalkBack: ${s}`));
    }
  } catch (e) { lines.push(`error: ${String(e).slice(0, 200)}`); }
  const dir = path.join('transcripts', pg.slug); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'talkback-transcript.txt'), lines.join('\n') + '\n');
  console.log('TRANSCRIPT', pg.slug, lines.length, 'lines');
  await sleep(2000);
}
await context.close().catch(() => {});
await device.close().catch(() => {});
console.log('DRIVE-DONE');
