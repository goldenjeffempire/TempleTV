import type { z } from "zod";
import type { ListUsersQuerySchema, UpdateUserRoleBodySchema } from "./admin.schemas.js";
type ConcurrentBucket = {
    ts: string;
    concurrent: number;
    tv: number;
    mobile: number;
    web: number;
};
type ConcurrentResult = {
    buckets: ConcurrentBucket[];
    peak: {
        concurrent: number;
        ts: string;
    };
    granularity: "hour" | "4h" | "day";
    generatedAt: string;
};
type DailyPlatformDay = {
    date: string;
    tv: number;
    mobile: number;
    web: number;
    total: number;
};
type DailyPlatformResult = {
    days: DailyPlatformDay[];
    generatedAt: string;
};
type GeoAnalyticsResult = {
    countries: {
        country: string;
        sessions: number;
    }[];
    totalWithGeo: number;
    unknown: number;
    generatedAt: string;
};
export declare const adminService: {
    listUsers(query: z.infer<typeof ListUsersQuerySchema>): Promise<{
        items: {
            id: string;
            email: string;
            displayName: string;
            avatarUrl: string | null;
            role: string;
            emailVerified: boolean;
            createdAt: string;
            updatedAt: string;
        }[];
        total: number;
        limit: number;
        offset: number;
    }>;
    updateUserRole(id: string, body: z.infer<typeof UpdateUserRoleBodySchema>): Promise<{
        id: string;
        email: string;
        displayName: string;
        avatarUrl: string | null;
        role: string;
        emailVerified: boolean;
        createdAt: string;
        updatedAt: string;
    }>;
    getStats(): Promise<{
        videos: {
            total: number;
            featured: number;
            bySource: Record<string, number>;
        };
        users: {
            total: number;
            byRole: Record<string, number>;
        };
        playlists: {
            total: number;
        };
        schedule: {
            total: number;
            active: number;
        };
        notifications: {
            sentLast24h: number;
            sentTotal: number;
        };
        broadcast: {
            queueDepth: number;
            activeQueueDepth: number;
        };
        devices: {
            total: number;
        };
        generatedAt: string;
    }>;
    getAnalytics(): Promise<{
        topVideos: {
            id: string;
            title: string;
            viewCount: number;
            thumbnailUrl: string;
        }[];
        totalViews: number;
        generatedAt: string;
    }>;
    getAnalyticsOverview(range?: "7d" | "30d" | "90d"): Promise<{
        totalViews: number;
        totalSessions: number;
        completionRate: number;
        avgWatchSecs: number;
        platformBreakdown: {
            platform: "mobile" | "tv" | "web";
            sessions: number;
        }[];
        dailyViews: {
            date: string;
            views: number;
        }[];
        topVideos: {
            id: string;
            title: string;
            viewCount: number;
            thumbnailUrl: string;
        }[];
        generatedAt: string;
    }>;
    deleteUser(id: string): Promise<{
        deleted: true;
        id: string;
    }>;
    getConcurrentViewers(range: "7d" | "30d" | "90d"): Promise<ConcurrentResult>;
    getDailyPlatformTrends(range: "7d" | "30d" | "90d"): Promise<DailyPlatformResult>;
    /**
     * Viewers-by-country breakdown for the admin geographic analytics panel.
     * Aggregates viewer_sessions by the edge-derived `country` column (see
     * analytics.routes.ts deriveCountry). Returns the top countries by session
     * count plus a bucket for sessions with no resolvable country.
     */
    getGeoAnalytics(range?: "7d" | "30d" | "90d"): Promise<GeoAnalyticsResult>;
};
export {};
