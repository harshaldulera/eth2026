"use client";

import { Sprite } from "@/components/pixel/sprite";
import type { VaultPose } from "@/lib/scene/player";

export type VaultDoorProps = {
  pose: VaultPose;
  scale?: number;
  /** Lockdown: the shutter drops over the door. */
  shutter?: boolean;
  className?: string;
};

/**
 * The vault door behind the guard: closed, shaking under heavy threat, or swinging open on a breach
 * (one-shot, ends open). The lockdown shutter drops over it.
 *
 * @example <VaultDoor pose={frame.vault} shutter={frame.stamp?.kind === "lockdown"} scale={6} />
 */
export function VaultDoor({ pose, scale = 6, shutter, className }: VaultDoorProps) {
  const name = pose === "open" ? "door.open" : pose === "shaking" ? "door.shaking" : "door.closed";
  return (
    <span className={["relative inline-block", className].filter(Boolean).join(" ")} style={{ width: 16 * scale, height: 16 * scale }}>
      <Sprite name={name} scale={scale} animate={pose !== "closed"} label={`Vault door ${pose}`} />
      {shutter ? (
        <span className="absolute inset-0">
          <Sprite name="shutter" scale={scale} animate label="Shutter down" />
        </span>
      ) : null}
    </span>
  );
}
