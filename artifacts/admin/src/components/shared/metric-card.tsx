import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";

interface MetricCardProps {
  title: string;
  value?: string | number | null;
  subtitle?: string;
  icon?: ReactNode;
  trend?: { value: number; label?: string };
  loading?: boolean;
  className?: string;
  valueClassName?: string;
  highlight?: "success" | "warning" | "danger" | "info";
}

const highlightStyles = {
  success: "border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-900",
  warning: "border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900",
  danger: "border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900",
  info: "border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-900",
};

export function MetricCard({
  title,
  value,
  subtitle,
  icon,
  trend,
  loading,
  className,
  valueClassName,
  highlight,
}: MetricCardProps) {
  return (
    <Card className={cn(highlight && highlightStyles[highlight], className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {icon && <div className="text-muted-foreground">{icon}</div>}
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <>
            <Skeleton className="h-8 w-24 mb-1" />
            {subtitle && <Skeleton className="h-3.5 w-32" />}
          </>
        ) : (
          <>
            <div className={cn("text-2xl font-bold tracking-tight", valueClassName)}>
              {value ?? "—"}
            </div>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
            )}
            {trend !== undefined && (
              <div
                className={cn(
                  "flex items-center gap-1 text-xs mt-1.5 font-medium",
                  trend.value >= 0 ? "text-emerald-600" : "text-red-500",
                )}
              >
                {trend.value >= 0 ? (
                  <TrendingUp className="w-3 h-3" />
                ) : (
                  <TrendingDown className="w-3 h-3" />
                )}
                {trend.value >= 0 ? "+" : ""}
                {trend.value}%{trend.label && ` ${trend.label}`}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
