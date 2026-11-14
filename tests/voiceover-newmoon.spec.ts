// Real macOS VoiceOver session, driven with Guidepup, against the published www.newmoonsushi.com as it is on the session
// date (used for the baseline of 28 October 2026 and for the verification runs after remediation). One test per page.
// Each test writes transcripts/<slug>/voiceover-transcript-<browser>.txt (header + "### " sections + numbered phrases).
// Read-only: only GET requests reach the site; no form exists on it.
import { voiceOverTest as test } from "@guidepup/playwright";
import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { release } from "node:os";

const ORIGIN = "https://www.newmoonsushi.com";
// read = upper bound of VO-Right Arrow steps; the read normally ends with "end of content" well before it.
const PAGES = [
  { slug: "home", path: "/", read: 200 },
  { slug: "gallery", path: "/gallery", read: 250 },
  { slug: "menu", path: "/menu", read: 200 },
  { slug: "lunch-menu", path: "/lunch-menu", read: 500 },
  { slug: "dinner-menu", path: "/dinner-menu", read: 500 },
  { slug: "sushi-menu", path: "/sushi-menu", read: 500 },
  { slug: "dessert-menu", path: "/dessert-menu", read: 250 },
  { slug: "sake-menu", path: "/sake-menu", read: 400 },
  { slug: "contact", path: "/contact", read: 200 },
  { slug: "accessibility", path: "/accessibility", read: 250 },
  { slug: "sitemap", path: "/sitemap", read: 250 },
];
// VO_MODE: one line for the transcript header that says what state of the site was tested.
const MODE = process.env.VO_MODE || "real session on the published site as it was on the session date";
const wanted = (process.env.VO_PAGES ?? "all").split(",").map((s) => s.trim()).filter(Boolean);
const selected = wanted.includes("all") ? PAGES : PAGES.filter((p) => wanted.includes(p.slug));
const HEADING_STEPS = Number(process.env.VO_HEADING_STEPS ?? 20);
const LANDMARK_STEPS = Number(process.env.VO_LANDMARK_STEPS ?? 10);
const TAB_STEPS = Number(process.env.VO_TAB_STEPS ?? 25);
const READ_SCALE = Number(process.env.VO_READ_SCALE ?? 1);
const READ_BUDGET_MS = Number(process.env.VO_READ_BUDGET_MIN ?? 30) * 60 * 1000;

type Section = { title: string; phrases: string[]; end: string; notes?: string[] };
const num = (i: number) => String(i).padStart(3, " ");

test.describe("VoiceOver — www.newmoonsushi.com", () => {
  for (const pg of selected) {
    test(`${pg.slug}: read-through, headings, landmarks, Tab order${pg.slug === "gallery" ? ", photo viewer" : ""}`, async ({ page, voiceOver, browserName }, testInfo) => {
      const t0 = Date.now();
      const left = () => testInfo.timeout - (Date.now() - t0);
      // GET only, at most one request per second to the site's own host.
      let last = 0;
      await page.route(/^https?:\/\/(www\.)?newmoonsushi\.com\//, async (route) => {
        if (route.request().method() !== "GET") return route.abort();
        const wait = last + 1000 - Date.now(); last = Math.max(Date.now(), last + 1000);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        return route.continue();
      });
      const url = `${ORIGIN}${pg.path}`;
      await page.goto(url, { waitUntil: "load" });
      await page.locator("body").waitFor();
      await page.waitForTimeout(4000);

      await voiceOver.navigateToWebContent();
      await voiceOver.clearSpokenPhraseLog();
      await voiceOver.clearItemTextLog();

      const sections: Section[] = [];
      const back = async () => { try { await voiceOver.navigateToWebContent(); } catch (e) { sections.push({ title: "(VoiceOver restarted)", phrases: [], end: String(e).slice(0, 100) }); try { await voiceOver.stop(); } catch {} await voiceOver.start(); await page.bringToFront().catch(() => {}); await voiceOver.navigateToWebContent(); } };
      const say = async () => (await voiceOver.lastSpokenPhrase()).replace(/\s+/g, " ").trim();
      const focusInfo = () => page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return "none";
        const label = el.getAttribute("aria-label") || (el.innerText || "").trim().slice(0, 40);
        return `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}${label ? ` "${label.replace(/\s+/g, " ")}"` : ""}${el.closest("[role=dialog]") ? " (in dialog)" : ""}`;
      });

      // Stop when the same phrase repeats three times in a row (end of content) or when the first phrase comes back (wrap-around).
      const run = async (title: string, max: number, step: () => Promise<void>, wrap: boolean, budgetEnd = Infinity, reserve = 4 * 60 * 1000) => {
        const phrases: string[] = []; let end = `limit of ${max} steps`; let repeat = 0;
        for (let i = 1; i <= max; i++) {
          if (Date.now() > budgetEnd) { end = `time budget of ${Math.round(READ_BUDGET_MS / 60000)} min reached after ${phrases.length} phrases`; break; }
          if (left() < reserve) { end = `stopped to keep time for the remaining sections (${Math.round(left() / 60000)} min left)`; break; }
          try { await step(); } catch (e) { end = `error: ${String(e).slice(0, 120)}`; break; }
          const p = await say();
          if (/Quick Note dialog/.test(p)) { end = "interrupted: macOS Quick Note dialog opened (runner hot corner)"; phrases.push(p); break; }
          if (phrases.length && p === phrases[phrases.length - 1]) { if (++repeat >= 2) { end = "end of content (repeated phrase)"; break; } } else repeat = 0;
          if (wrap && phrases.length > 1 && p === phrases[0]) { end = "wrapped to the first item"; break; }
          phrases.push(p);
        }
        sections.push({ title, phrases, end });
        flush();
        return phrases;
      };

      const header = (total: number) => [
        `Screen reader: VoiceOver (macOS ${release()}, real session driven with Guidepup)`,
        `Page: ${url}`,
        `Rendered page: ${page.url()}`,
        `Browser: ${browserName} (Playwright project "${testInfo.project.name}")`,
        `Runner: GitHub Actions ${process.env.RUNNER_OS_LABEL ?? "local"}`,
        `Session date (UTC): ${new Date().toISOString()}`,
        `Mode: ${MODE}`,
        `Read-through: up to ${Math.round(pg.read * READ_SCALE)} steps (read_scale ${READ_SCALE}), time budget ${Math.round(READ_BUDGET_MS / 60000)} min`,
        `Phrases captured: ${total}`,
        ``,
        `Each line is one phrase exactly as VoiceOver spoke it.`,
        `────────────────────────────────────────────────────────`,
        ``,
      ];
      const outDir = join(process.cwd(), "transcripts", pg.slug);
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, `voiceover-transcript-${browserName}.txt`);
      // Written after every section, so a runner that dies or a timeout still leaves the sections already captured.
      function flush(spoken?: string[]) {
        const total = sections.reduce((a, s) => a + s.phrases.length, 0);
        const lines = header(total);
        for (const s of sections) {
          lines.push(`### ${s.title} (${s.phrases.length} phrases, end: ${s.end})`);
          s.phrases.forEach((p, i) => lines.push(`${num(i + 1)}  ${p}`));
          (s.notes ?? []).forEach((n) => lines.push(`     note: ${n}`));
          lines.push("");
        }
        if (spoken) {
          lines.push(`### Full VoiceOver log (spokenPhraseLog, ${spoken.length} entries)`);
          spoken.forEach((p, i) => lines.push(`${num(i + 1)}  ${p.replace(/\s+/g, " ").trim()}`));
        } else lines.push(`### (session still running or interrupted: full VoiceOver log not written yet)`);
        writeFileSync(file, lines.join("\n") + "\n", "utf8");
      }

      const vo: any = voiceOver;
      // VO_VIEWER_ONLY=1 reruns only the gallery photo-viewer scenario.
      const viewerOnly = process.env.VO_VIEWER_ONLY === "1";
      // VO_MENU_ONLY=1 runs only the accessibility-menu scenario (use it with pages=home).
      const menuOnly = process.env.VO_MENU_ONLY === "1";
      if (!viewerOnly && !menuOnly) {
      await run("Read-through from the top (VO-Right Arrow)", Math.round(pg.read * READ_SCALE), () => voiceOver.next({ capture: true }), false, t0 + READ_BUDGET_MS, 12 * 60 * 1000);

      await back();
      await run("Heading navigation (VO-Cmd-H)", HEADING_STEPS, () => voiceOver.nextHeading({ capture: true }), true);

      await back();
      const landmarkCmd = vo.keyboardCommands?.findNextLandmark ?? vo.keyboardCommands?.findNextLandmarkOrItem;
      if (typeof vo.nextLandmark === "function") await run("Landmark navigation (VO-Cmd-L)", LANDMARK_STEPS, () => vo.nextLandmark({ capture: true }), true);
      else if (landmarkCmd) await run("Landmark navigation (VO-Cmd-L)", LANDMARK_STEPS, () => voiceOver.perform(landmarkCmd, { capture: true }), true);
      else sections.push({ title: "Landmark navigation (VO-Cmd-L)", phrases: [], end: "command not available in this Guidepup version" });

      await back();
      const tabNotes: string[] = [];
      await run("Tab order (Tab key)", TAB_STEPS, async () => { await voiceOver.press("Tab"); tabNotes.push(`Tab ${tabNotes.length + 1}: focus ${await focusInfo()}`); }, false, Infinity, 2 * 60 * 1000);
      sections[sections.length - 1].notes = tabNotes;
      flush();
      }

      // Gallery photo viewer: open the first photo with Enter, close it with Escape, see where keyboard focus goes (F5).
      if (pg.slug === "gallery" && !menuOnly && left() > 4 * 60 * 1000) {
        const phrases: string[] = []; const notes: string[] = [];
        try {
          await page.goto(url, { waitUntil: "load" });
          await page.waitForTimeout(4000);
          await back();
          // Tab from the top until keyboard focus is on the first photo (focus() from script left VoiceOver elsewhere).
          const onPhoto = () => page.evaluate(() => !!document.activeElement?.closest('[data-hook="item-container"]'));
          let tabs = 0;
          while (tabs < 20 && !(await onPhoto())) { await voiceOver.press("Tab"); tabs++; }
          if (!(await onPhoto())) throw new Error(`first photo not reached after ${tabs} Tab presses (focus ${await focusInfo()})`);
          phrases.push(await say());
          notes.push(`Reached the first photo after ${tabs} Tab presses: ${await focusInfo()}.`);
          await voiceOver.press("Enter"); await page.waitForTimeout(2000); phrases.push(await say());
          notes.push(`After Enter: dialog open ${await page.evaluate(() => !!document.querySelector('[role="dialog"]'))}; focus ${await focusInfo()}.`);
          await voiceOver.press("Tab"); phrases.push(await say());
          await voiceOver.press("Tab"); phrases.push(await say());
          await voiceOver.press("Escape"); await page.waitForTimeout(1500); phrases.push(await say());
          notes.push(`After Escape: focus ${await focusInfo()}.`);
          await voiceOver.press("Tab"); phrases.push(await say());
          notes.push(`After the next Tab: focus ${await focusInfo()}.`);
          notes.push("Phrases: 1 Tab onto the first photo, 2 Enter (open), 3-4 Tab inside the viewer, 5 Escape (close), 6 next Tab.");
          sections.push({ title: "Gallery photo viewer: open with Enter, close with Escape", phrases, end: "scenario complete", notes });
        } catch (e) { sections.push({ title: "Gallery photo viewer: open with Enter, close with Escape", phrases, end: `error: ${String(e).slice(0, 160)}`, notes }); }
        flush();
      }

      // Accessibility menu: Tab to the menu button, open the dialog with Enter, Tab through it, close it with Escape.
      if (menuOnly && left() > 3 * 60 * 1000) {
        const title = "Accessibility menu: Tab to the menu button, open with Enter, Tab through the dialog, close with Escape";
        const phrases: string[] = []; const notes: string[] = [];
        const expanded = () => page.evaluate(() => document.getElementById("nms-a11y-open")?.getAttribute("aria-expanded") ?? "none");
        const dialogOpen = () => page.evaluate(() => { const d = document.getElementById("nms-a11y-dialog"); return !!d && !d.hidden && getComputedStyle(d).display !== "none" && getComputedStyle(d).visibility !== "hidden"; });
        try {
          await back();
          const onButton = () => page.evaluate(() => document.activeElement?.id === "nms-a11y-open");
          let tabs = 0;
          while (tabs < 40 && !(await onButton())) { await voiceOver.press("Tab"); tabs++; }
          if (!(await onButton())) throw new Error(`menu button not reached after ${tabs} Tab presses (focus ${await focusInfo()})`);
          phrases.push(await say());
          notes.push(`Reached the menu button after ${tabs} Tab presses: ${await focusInfo()}; aria-expanded ${await expanded()}.`);
          await voiceOver.press("Enter"); await page.waitForTimeout(1500); phrases.push(await say());
          notes.push(`After Enter: dialog open ${await dialogOpen()}; aria-expanded ${await expanded()}; focus ${await focusInfo()}.`);
          for (let i = 1; i <= 24; i++) { await voiceOver.press("Tab"); phrases.push(await say()); notes.push(`Tab ${i} in the dialog: focus ${await focusInfo()}.`); }
          await voiceOver.press("Escape"); await page.waitForTimeout(1200); phrases.push(await say());
          notes.push(`After Escape: dialog open ${await dialogOpen()}; aria-expanded ${await expanded()}; focus ${await focusInfo()}.`);
          notes.push("Phrases: 1 the menu button, 2 Enter (open), 3-26 Tab inside the dialog, 27 Escape (close).");
          sections.push({ title, phrases, end: "scenario complete", notes });
        } catch (e) { sections.push({ title, phrases, end: `error: ${String(e).slice(0, 160)}`, notes }); }
        flush();
      }

      const spoken: string[] = await voiceOver.spokenPhraseLog().catch(() => [] as string[]);
      const total = sections.reduce((a, s) => a + s.phrases.length, 0);
      flush(spoken);
      await testInfo.attach(`voiceover-${pg.slug}-${browserName}`, { path: file, contentType: "text/plain" });
      expect(total).toBeGreaterThan(viewerOnly || menuOnly ? 3 : 10);
    });
  }
});
