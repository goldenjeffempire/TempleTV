import { useCallback, useEffect, useRef, useState } from "react";

export interface TVNavConfig {
  rowCount: number;
  getRowItemCount: (rowIndex: number) => number;
  onSelect: (rowIndex: number, itemIndex: number) => void;
  onBack?: () => void;
  enabled?: boolean;
}

export function useTVNav({
  rowCount,
  getRowItemCount,
  onSelect,
  onBack,
  enabled = true,
}: TVNavConfig) {
  const [focusRow, setFocusRow] = useState(0);
  const [focusItems, setFocusItems] = useState<number[]>([]);

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
        setFocusRow((r) => Math.max(0, r - 1));
      } else if (key === "ArrowDown") {
        e.preventDefault();
        setFocusRow((r) => Math.min(rowCount - 1, r + 1));
      } else if (key === "ArrowLeft") {
        e.preventDefault();
        setFocusRow((row) => {
          const cur = getFocusItem(row);
          setFocusItem(row, Math.max(0, cur - 1));
          return row;
        });
      } else if (key === "ArrowRight") {
        e.preventDefault();
        setFocusRow((row) => {
          const cur = getFocusItem(row);
          const max = getRowItemCount(row) - 1;
          setFocusItem(row, Math.min(max, cur + 1));
          return row;
        });
      } else if (key === "Enter" || key === " ") {
        e.preventDefault();
        const item = getFocusItem(focusRow);
        onSelect(focusRow, item);
      } else if (key === "Backspace" || key === "Escape") {
        e.preventDefault();
        onBack?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, rowCount, focusRow, getRowItemCount, getFocusItem, setFocusItem, onSelect, onBack]);

  return { focusRow, focusItem: getFocusItem(focusRow), getFocusItem };
}
