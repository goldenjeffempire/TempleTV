import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  badge?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, badge, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4", className)}>
      <div className="flex items-start gap-3 min-w-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-[1.45rem] sm:text-[1.65rem] font-bold tracking-[-0.025em] leading-tight text-gradient-mixed">
              {title}
            </h1>
            {badge}
          </div>
          {description && (
            <p className="text-muted-foreground/75 mt-1.5 text-sm leading-relaxed max-w-2xl">
              {description}
            </p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:pt-0.5">{actions}</div>
      )}
    </div>
  );
}
