#!/usr/bin/env node
// Downloads Kenney's CC0 "Tiny Dungeon" tiles (16x16 PNGs) from the
// github.com/shorepine/kenney mirror into public/pixel/tiny-dungeon/tiles/.
// Usage: node qa/fetch-assets.mjs [--force]
// Needs network once; already-downloaded tiles are skipped unless --force.
// No dependencies (Node 18+ global fetch).
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "pixel", "tiny-dungeon", "tiles");
const LICENSE = join(ROOT, "public", "pixel", "LICENSE-kenney.txt");
const BASE = "https://raw.githubusercontent.com/shorepine/kenney/HEAD/2d/Tiny%20Dungeon/Tiles/";
const MAX = 131;
const force = process.argv.includes("--force");

const LICENSE_TEXT = `Tiny Dungeon
by Kenney (https://kenney.nl)

Licence: Creative Commons Zero, CC0 1.0 Universal
https://creativecommons.org/publicdomain/zero/1.0/

The tiles in public/pixel/tiny-dungeon/tiles/ are Kenney's "Tiny Dungeon"
pack, fetched from the mirror github.com/shorepine/kenney
(2d/Tiny Dungeon/Tiles/) by qa/fetch-assets.mjs.

You may use these assets in personal, educational and commercial projects.
Credit is not required, but is appreciated: "Kenney" / www.kenney.nl
`;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function fetchTile(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await writeFile(LICENSE, LICENSE_TEXT);
  let got = 0, skipped = 0;
  for (let i = 0; i <= MAX; i++) {
    const name = `tile_${String(i).padStart(4, "0")}.png`;
    const dest = join(OUT, name);
    if (!force && (await exists(dest))) { skipped++; continue; }
    const buf = await fetchTile(BASE + name);
    if (!buf) { console.log(`404 at ${name}; stopping`); break; }
    if (!PNG_SIG.every((b, k) => buf[k] === b)) throw new Error(`${name} is not a PNG`);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (w !== 16 || h !== 16) console.warn(`warning: ${name} is ${w}x${h}, expected 16x16`);
    await writeFile(dest, buf);
    got++;
  }
  console.log(`tiny-dungeon: ${got} downloaded, ${skipped} already present -> ${OUT}`);
  console.log(`licence -> ${LICENSE}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
