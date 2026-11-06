/** One line per worker action. ✓ success, ✗ failure, · info. Quiet with WORKER_QUIET=1 (demo narrates itself). */

const g = globalThis as unknown as { __siegeWorkerQuiet?: boolean };

export function setWorkerQuiet(quiet: boolean) {
  g.__siegeWorkerQuiet = quiet;
}

const stamp = () => new Date().toISOString().slice(11, 19);
const quiet = () => g.__siegeWorkerQuiet ?? process.env.WORKER_QUIET === "1";

export const log = {
  ok: (msg: string) => !quiet() && console.log(`${stamp()} ✓ ${msg}`),
  fail: (msg: string) => !quiet() && console.log(`${stamp()} ✗ ${msg}`),
  info: (msg: string) => !quiet() && console.log(`${stamp()} · ${msg}`),
};
