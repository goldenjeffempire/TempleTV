---
name: Heap-used slope watchdog thresholds
description: Design rationale for heapUsed slope alert thresholds in memory-watchdog.ts — intentionally asymmetric to avoid GC-cycle false positives.
---

## The rule
heapUsed slope alert fires at **30 MB/min sustained for 3 consecutive 30-second samples** (= 90 seconds). Recovery requires slope below **5 MB/min**. These are intentionally asymmetric.

## Why
GC cycles cause heapUsed to oscillate significantly — a single collection can momentarily make the slope highly negative, then a burst of allocations swings it positive. Using 3 consecutive samples (90 s of data) avoids single-cycle false positives. The low recovery threshold (5 MB/min vs 30 MB/min alert) prevents alert flapping on borderline-leaking workloads. external memory uses 50 MB/min alert / 10 MB/min recovery for the same reason.

## How to apply
- Don't lower the alert below 20 MB/min — normal GC activity can produce 15–18 MB/min transient spikes.
- Don't raise the recovery threshold above 10 MB/min or alerts will re-trigger immediately after recovery.
- When a heap slope alert fires in production, use `POST /admin/diagnostics/heap-snapshot` (rate-limited 2/hour) to capture a heapdump for offline analysis in Chrome DevTools > Memory.
