import { useCallback, useEffect, useRef, useState } from "react";
import { keyEventToAction } from "../lib/tvKeys";

export interface TVNavConfig {
  rowCount: number;
  getRowItemCount: (rowIndex: number) => number;
  onSelect: (rowIndex: number, itemIndex: number) => void;
  onBack?: () => void;
  enabled?: boolean;
  headerItemCount?: number;
  onHeaderSelect?: (itemIndex: number) => void;
}

export type TVFocusZone = "header" | "grid";

export function useTVNav({
  rowCount,
  getRowItemCount,
  onSelect,
  onBack,
  enabled = true,
  headerItemCount = 0,
  onHeaderSelect,
}: TVNavConfig) {
  const [focusZone, setFocusZone] = useState<TVFocusZone>("grid");
  const [focusRow, setFocusRow] = useState(0);
  const [focusItems, setFocusItems] = useState<number[]>([]);
  const [headerItem, setHeaderItem] = useState(0);

  // Track refs to avoid stale closures in the event handler
  const stateRef = useRef({ focusZone, focusRow, focusItems, headerItem });
  stateRef.current = { focusZone, focusRow, focusItems, headerItem };

  const getFocusItem = useCallback(
    (row: number) => focusItems[row] ?? 0,
    [focusItems],
  );

  const setFocusItem = useCallback((row: number, item: number) => {
    setFocusItems((prev) => {
      const next = [...prev];
      next[row] = item;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      const action = keyEventToAction(e);
      if (!action) return;

      const { focusZone: zone, focusRow: row, headerItem: hi } = stateRef.current;
      const getFI = (r: number) => stateRef.current.focusItems[r] ?? 0;

      switch (action) {
        case "up":
          e.preventDefault();
          if (zone === "header") return;
          if (row === 0 && headerItemCount > 0) {
            setFocusZone("header");
            return;
          }
          setFocusRow((r) => Math.max(0, r - 1));
          break;

        case "down":
          e.preventDefault();
          if (zone === "header") {
            setFocusZone("grid");
            setFocusRow(0);
            return;
          }
          setFocusRow((r) => Math.min(rowCount - 1, r + 1));
          break;

        case "left":
          e.preventDefault();
          if (zone === "header") {
            setHeaderItem((i) => Math.max(0, i - 1));
            return;
          }
          setFocusRow((r) => {
            const cur = getFI(r);
            setFocusItem(r, Math.max(0, cur - 1));
            return r;
          });
          break;

        case "right":
          e.preventDefault();
          if (zone === "header") {
            setHeaderItem((i) => Math.min(headerItemCount - 1, i + 1));
            return;
          }
          setFocusRow((r) => {
            const cur = getFI(r);
            const max = getRowItemCount(r) - 1;
            setFocusItem(r, Math.min(max, cur + 1));
            return r;
          });
          break;

        case "select":
          e.preventDefault();
          if (zone === "header") {
            onHeaderSelect?.(hi);
            return;
          }
          onSelect(row, getFI(row));
          break;

        case "back":
        case "exit":
          e.preventDefault();
          onBack?.();
          break;

        default:
          break;
      }
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [
    enabled,
    rowCount,
    headerItemCount,
    getRowItemCount,
    setFocusItem,
    onSelect,
    onBack,
    onHeaderSelect,
  ]);

  return {
    focusRow,
    focusItem: getFocusItem(focusRow),
    getFocusItem,
    focusZone,
    headerItem,
  };
}
