import React from "react";
import { AppHeader } from "@/components/AppHeader";

interface ScreenHeaderProps {
  title: string;
}

/**
 * Tab-screen header — thin wrapper around AppHeader (variant="tab").
 *
 * Renders the Temple TV logo on the left and the screen title on the right.
 * Safe-area inset is handled internally by AppHeader.
 *
 * Usage:
 *   <ScreenHeader title="Library" />
 */
export function ScreenHeader({ title }: ScreenHeaderProps) {
  return <AppHeader variant="tab" title={title} />;
}
