#!/usr/bin/env node
/**
 * qa/sfx-smoke.mjs — the sound engine in a real browser against a running app (plan §7.5):
 *   1. no AudioContext runs before a gesture (autoplay policy, design §9);
 *   2. the first click unlocks audio: an AudioContext exists and its state is "running";
 *   3. window.__siegeSfx.playAll() plays every cue without a page error or console error;
 *   4. M mutes, the mute survives a reload (localStorage siege.sfx.muted = "1"), M unmutes.
 *
 * Dev or production build. window.__siegeSfx (playAll) is a dev-only tool: against `next start` the
 * playAll check is marked skipped (not failed), and the gesture/unlock/mute checks still run off the
 * instrumented AudioContext.
 * Usage: node qa/sfx-smoke.mjs [--base http://localhost:4650] [--route /] [--gap 30]
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const CACHED_SHELL = "/home/dhruv1238/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell";
const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: process.env.QA_BASE_URL || "http://localhost:4650" },
    route: { type: "string", default: "/" },
    gap: { type: "string", default: "30" },
    chrome: { type: "string", default: process.env.QA_CHROME || "" },
  },
});
const URL_ = args.base.replace(/\/$/, "") + args.route;

/** Record every AudioContext the page makes (the engine creates one lazily inside unlock()). */
const INSTRUMENT = () => {
  const W = window;
  W.__qaAudio = [];
  for (const k of ["AudioContext", "webkitAudioContext"]) {
    const Orig = W[k];
    if (!Orig) continue;
    W[k] = class extends Orig {
      constructor(...a) {
        super(...a);
        W.__qaAudio.push(this);
      }
    };
  }
};

/** Whether the page exposes window.__siegeSfx (null until the first load says). */
let hasTool = null;

/** goto with a retry: a dev server mid-compile can abort the first navigation (ERR_ABORTED). */
async function load(page) {
  for (let i = 1; ; i++) {
    try {
      let navs = 0;
      const onNav = () => navs++; // full document loads only
      page.on("domcontentloaded", onNav);
      await page.goto(URL_, { waitUntil: "load", timeout: 60_000 });
      // wait out dev-server "HMR hash mismatch" reloads (a still-compiling dev server sends a few)
      for (let seen = navs, quiet = Date.now(), until = Date.now() + 30_000; Date.now() < until; ) {
        await page.waitForTimeout(250);
        if (navs !== seen) [seen, quiet] = [navs, Date.now()];
        else if (Date.now() - quiet >= 1_500) break;
      }
      page.off("domcontentloaded", onNav);
      await page.waitForLoadState("load");
      // dev builds expose the tool once hydrated; a production build never does: only wait the first time
      if (hasTool !== false) {
        hasTool = await page
          .waitForFunction(() => Boolean(window.__siegeSfx), null, { timeout: hasTool === null ? 15_000 : 30_000 })
          .then(() => true)
          .catch(() => false);
      }
      return;
    } catch (e) {
      if (i >= 3 || !/ERR_ABORTED|frame was detached|interrupted/i.test(e.message)) throw e;
      await page.waitForTimeout(1_000);
    }
  }
}

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
};
const skip = (name, detail = "") => {
  checks.push({ name, ok: true, skipped: true, detail });
  console.log(`– ${name}  (skipped${detail ? `: ${detail}` : ""})`);
};

async function main() {
  const exe = args.chrome || (existsSync(CACHED_SHELL) ? CACHED_SHELL : undefined);
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(INSTRUMENT);
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 240)}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 240)}`));

  console.log(`sfx-smoke → ${URL_}`);
  await load(page);
  // Start unmuted whatever an earlier run left behind.
  await page.evaluate(() => localStorage.removeItem("siege.sfx.muted"));
  await load(page);
  await page.waitForTimeout(800);

  const tool = await page.evaluate(() => (window.__siegeSfx ? window.__siegeSfx.list() : null));
  if (tool) check("window.__siegeSfx is present (dev build)", Array.isArray(tool), `${tool.length} cues`);
  else skip("window.__siegeSfx (dev tool)", "production build: playAll is not exposed");

  const before = await page.evaluate(() => window.__qaAudio.map((c) => c.state));
  check("no running AudioContext before a gesture", !before.includes("running"), `contexts: [${before.join(", ")}]`);

  // The first click unlocks (SfxBoot listens for pointerdown): click a heading, never a link.
  const h1 = page.locator("h1").first();
  if (await h1.count()) await h1.click({ position: { x: 2, y: 2 } });
  else await page.mouse.click(2, 600);
  await page.waitForFunction(() => window.__qaAudio.some((c) => c.state === "running"), null, { timeout: 5_000 }).catch(() => {});
  const after = await page.evaluate(() => window.__qaAudio.map((c) => c.state));
  check("first click unlocks audio (AudioContext running)", after.includes("running"), `contexts: [${after.join(", ")}]`);

  if (tool) {
    const errBefore = errors.length;
    const t0 = Date.now();
    const played = await page.evaluate(async (gap) => {
      try {
        await window.__siegeSfx.playAll(gap);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, Number(args.gap));
    check(`playAll() played all ${tool.length} cues`, played.ok && errors.length === errBefore, played.ok ? `${Date.now() - t0} ms, ${errors.length - errBefore} errors` : played.error);
  } else skip("playAll() plays every cue", "needs the dev tool");

  // Mute with M (SfxBoot), reload, still muted; M again unmutes.
  await page.keyboard.press("m");
  await page.waitForTimeout(200);
  const muted = await page.evaluate(() => localStorage.getItem("siege.sfx.muted"));
  check("M mutes (siege.sfx.muted = 1)", muted === "1", `stored ${JSON.stringify(muted)}`);
  await load(page);
  await page.waitForTimeout(1_500);
  const kept = await page.evaluate(() => ({
    stored: localStorage.getItem("siege.sfx.muted"),
    label: document.querySelector('button[aria-label^="Sound off"]')?.getAttribute("aria-label") ?? null,
  }));
  check("mute survives a reload", kept.stored === "1", `stored ${JSON.stringify(kept.stored)}${kept.label ? `, HUD says "${kept.label}"` : ""}`);
  check("HUD shows the muted state after reload", kept.label !== null || args.route.startsWith("/wall"), kept.label ? "" : args.route.startsWith("/wall") ? "the wall has no HUD: skipped" : "no 'Sound off' button found");
  await page.keyboard.press("m");
  await page.waitForTimeout(200);
  const unmuted = await page.evaluate(() => localStorage.getItem("siege.sfx.muted"));
  check("M again unmutes (siege.sfx.muted = 0)", unmuted === "0", `stored ${JSON.stringify(unmuted)}`);

  return finish(browser, errors);
}

async function finish(browser, errors) {
  await browser.close();
  check("no console or page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  const failed = checks.filter((c) => !c.ok).length;
  const skipped = checks.filter((c) => c.skipped).length;
  const ran = checks.length - skipped;
  console.log(`sfx-smoke: ${ran - failed}/${ran} checks passed${skipped ? `, ${skipped} skipped (production build)` : ""}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`sfx-smoke: ${e.message}`);
  process.exit(1);
});
