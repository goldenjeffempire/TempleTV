import React from "react";
import { AppHeader } from "@/components/AppHeader";

interface ScreenHeaderProps {
  title: string;
}

/**
 * Tab-screen header — thin wrapper around AppHeader (variant="tab").
 *
 * Renders a large bold page title on the left. No app logo — the brand is
 * established by the app icon; repeating the wordmark on every tab header
 * competes with content hierarchy. The Watch/Live tab intentionally omits
 * this component entirely so the broadcast hero fills the full screen.
 *
 * Safe-area inset is handled internally by AppHeader.
 *
 * Usage:
 *   <ScreenHeader title="Library" />
 */
export function ScreenHeader({ title }: ScreenHeaderProps) {
  return <AppHeader variant="tab" title={title} />;
}
