import * as React from "react";
import { cn } from "@/lib/utils";
import { PanelTitle, panelVariants } from "@/components/pixel/panel";

/**
 * Panel surface (a PixelPanel frame). Props unchanged from Part 1.
 * @example <Card><CardHeader title="Recent ops" /><CardBody>…</CardBody></Card>
 */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn(panelVariants({ tone: "default" }), className)} {...props} />;
}

export function CardHeader({
  title,
  action,
  icon,
  className,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return <PanelTitle title={title} action={action} icon={icon} className={className} />;
}

export function CardBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />;
}
