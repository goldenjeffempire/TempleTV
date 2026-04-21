import { useCallback, useEffect, useRef, useState } from "react";

export interface TVNavConfig {
  rowCount: number;
  getRowItemCount: (rowIndex: number) => number;
  onSelect: (rowIndex: number, itemIndex: number) => void;
  onBack?: () => void;
  enabled?: boolean;
  /**
   * Optional header row that lives logically "above" row 0. When the user
   * presses ArrowUp at row 0, focus moves into the header. ArrowDown from the
   * header re-enters row 0. This was added so the Search/Guide buttons in
   * the TV Home header are reachable via D-pad alone (no keyboard shortcuts).
   */
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
      const key = e.key;
      if (key === "ArrowUp") {
        e.preventDefault();
        if (focusZone === "header") return; // already at top
        if (focusRow === 0 && headerItemCount > 0) {
          setFocusZone("header");
          return;
        }
        setFocusRow((r) => Math.max(0, r - 1));
      } else if (key === "ArrowDown") {
        e.preventDefault();
        if (focusZone === "header") {
          // Re-enter the grid at row 0 so this is explicit, not a side-effect
          // of focusRow happening to already be 0 when we left.
          setFocusZone("grid");
          setFocusRow(0);
          return;
        }
        setFocusRow((r) => Math.min(rowCount - 1, r + 1));
      } else if (key === "ArrowLeft") {
        e.preventDefault();
        if (focusZone === "header") {
          setHeaderItem((i) => Math.max(0, i - 1));
          return;
        }
        setFocusRow((row) => {
          const cur = getFocusItem(row);
          setFocusItem(row, Math.max(0, cur - 1));
          return row;
        });
      } else if (key === "ArrowRight") {
        e.preventDefault();
        if (focusZone === "header") {
          setHeaderItem((i) => Math.min(headerItemCount - 1, i + 1));
          return;
        }
        setFocusRow((row) => {
          const cur = getFocusItem(row);
          const max = getRowItemCount(row) - 1;
          setFocusItem(row, Math.min(max, cur + 1));
          return row;
        });
      } else if (key === "Enter" || key === " ") {
        e.preventDefault();
        if (focusZone === "header") {
          onHeaderSelect?.(headerItem);
          return;
        }
        const item = getFocusItem(focusRow);
        onSelect(focusRow, item);
      } else if (key === "Backspace" || key === "Escape") {
        e.preventDefault();
        onBack?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    enabled,
    rowCount,
    focusRow,
    focusZone,
    headerItem,
    headerItemCount,
    getRowItemCount,
    getFocusItem,
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
