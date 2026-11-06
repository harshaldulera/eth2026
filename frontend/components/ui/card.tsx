import * as React from "react";
import { cn } from "@/lib/utils";

/** Panel surface. @example <Card><CardHeader title="Recent sieges" /><CardBody>…</CardBody></Card> */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("relative rounded-2xl border border-arena-line bg-arena-panel/90 backdrop-blur-sm", className)}
      {...props}
    />
  );
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
  return (
    <div className={cn("flex items-center justify-between gap-3 border-b border-arena-line px-4 py-3", className)}>
      <h2 className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-stone uppercase [&_svg]:size-3.5">
        {icon}
        {title}
      </h2>
      {action}
    </div>
  );
}

export function CardBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />;
}
