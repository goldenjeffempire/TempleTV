import React from "react";
import { AppHeader } from "@/components/AppHeader";

interface ScreenHeaderProps {
  title: string;
  /** Optional element rendered to the left of the title (e.g. a back button). */
  left?: React.ReactNode;
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
 *   <ScreenHeader title="Notifications" left={<BackButton />} />
 */
export function ScreenHeader({ title, left }: ScreenHeaderProps) {
  return <AppHeader variant="tab" title={title} left={left} />;
}
