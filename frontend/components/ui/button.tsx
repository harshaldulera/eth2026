"use client";

import * as React from "react";
import type { VariantProps } from "class-variance-authority";
import { PixelButton, pixelButtonVariants } from "@/components/pixel/button";

/** Part 1 name for the pixel button variants (gold / ward / ember / emberSolid / outline / ghost still work). */
export const buttonVariants = pixelButtonVariants;

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Sound cue on click; default `ui_blip`, `null` for silence. */
    cue?: string | null;
  };

/**
 * Thin wrapper over PixelButton with the Part 1 props.
 * @example <Button variant="gold" size="lg" onClick={pay}>Run op</Button>
 */
export function Button(props: ButtonProps) {
  return <PixelButton {...props} />;
}
