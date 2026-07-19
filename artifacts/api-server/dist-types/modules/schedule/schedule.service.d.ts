import type { z } from "zod";
import type { CreateScheduleBodySchema, UpdateScheduleBodySchema } from "./schedule.schemas.js";
export declare const scheduleService: {
    /**
     * Lists all schedule entries.
     *
     * Recurring entries are sorted by dayOfWeek then startTime.
     * One-time (dated) entries are appended at the end, sorted by scheduledDate
     * then startTime.
     */
    list(): Promise<{
        items: {
            id: string;
            title: string;
            dayOfWeek: number | null;
            startTime: string;
            endTime: string | null;
            contentType: string;
            contentId: string | null;
            isRecurring: boolean;
            isActive: boolean;
            createdAt: string;
            scheduledDate: string | null;
            priorityOverride: boolean;
        }[];
        total: number;
    }>;
    /**
     * Returns upcoming one-time events (scheduledDate >= today) sorted by date
     * then startTime. Used by the admin "Upcoming Events" panel.
     */
    listUpcoming(): Promise<{
        items: {
            id: string;
            title: string;
            dayOfWeek: number | null;
            startTime: string;
            endTime: string | null;
            contentType: string;
            contentId: string | null;
            isRecurring: boolean;
            isActive: boolean;
            createdAt: string;
            scheduledDate: string | null;
            priorityOverride: boolean;
        }[];
        total: number;
    }>;
    create(body: z.infer<typeof CreateScheduleBodySchema>): Promise<{
        id: string;
        title: string;
        dayOfWeek: number | null;
        startTime: string;
        endTime: string | null;
        contentType: string;
        contentId: string | null;
        isRecurring: boolean;
        isActive: boolean;
        createdAt: string;
        scheduledDate: string | null;
        priorityOverride: boolean;
    }>;
    update(id: string, body: z.infer<typeof UpdateScheduleBodySchema>): Promise<{
        id: string;
        title: string;
        dayOfWeek: number | null;
        startTime: string;
        endTime: string | null;
        contentType: string;
        contentId: string | null;
        isRecurring: boolean;
        isActive: boolean;
        createdAt: string;
        scheduledDate: string | null;
        priorityOverride: boolean;
    }>;
    delete(id: string): Promise<{
        id: string;
        deleted: boolean;
    }>;
    /** Mark a one-time entry as inactive after it fires (prevents re-fire on server restart). */
    deactivateOneTime(id: string): Promise<void>;
    /**
     * Atomically claim a one-time schedule entry for firing by setting
     * `isActive = false` in a single UPDATE with an `is_active = true` guard.
     *
     * Returns `true` if the claim succeeded (this process owns the firing),
     * or `false` if the row was already claimed by another process or a prior
     * restart. The caller must only dispatch the entry's action when this
     * returns `true` — this prevents double-fire across process restarts and
     * concurrent replicas.
     *
     * Claim-before-fire pattern:
     *   1. claimOneTimeFiring() — atomic DB claim, deactivates the entry
     *   2. handleEntry()        — dispatch the broadcast action
     *
     * If the process crashes after step 1 but before step 2 completes the
     * entry stays inactive in the DB and does NOT re-fire on restart. A missed
     * fire (due to crash between claim and dispatch) is less harmful than a
     * double-fire (duplicate live overrides, two enqueues, two emails).
     */
    claimOneTimeFiring(id: string): Promise<boolean>;
};
