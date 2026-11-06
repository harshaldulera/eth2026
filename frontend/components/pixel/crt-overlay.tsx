/**
 * The CRT layer: scanlines, vignette and a faint flicker over the whole app. Pointer-transparent,
 * hidden by `html[data-crt="off"]`, still under reduced motion and on phones (globals.css).
 */
export function CrtOverlay() {
  return <div data-crt-overlay="" aria-hidden />;
}
