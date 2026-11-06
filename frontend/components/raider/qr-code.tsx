"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { cn } from "@/lib/utils";

/**
 * Crisp SVG QR code (dark on parchment so every phone camera reads it).
 *
 * @example <QrCode value="http://192.168.1.20:3000/raider/approvals" size={180} />
 */
export function QrCode({ value, size = 176, className }: { value: string; size?: number; className?: string }) {
  const [svg, setSvg] = useState<{ value: string; svg: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0b0a12", light: "#efe6d2" } })
      .then((s) => !cancelled && setSvg({ value, svg: s }))
      .catch(() => !cancelled && setSvg(null));
    return () => {
      cancelled = true;
    };
  }, [value]);
  return (
    <div
      className={cn("overflow-hidden rounded-xl bg-parchment p-1.5 [&_svg]:block [&_svg]:size-full", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`QR code for ${value}`}
      dangerouslySetInnerHTML={svg && svg.value === value ? { __html: svg.svg } : undefined}
    />
  );
}
