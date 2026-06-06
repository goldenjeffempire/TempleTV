import { z } from "zod";
export declare const AdminUserSchema: z.ZodObject<{
    id: z.ZodString;
    email: z.ZodString;
    displayName: z.ZodString;
    avatarUrl: z.ZodNullable<z.ZodString>;
    role: z.ZodString;
    emailVerified: z.ZodBoolean;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    email: string;
    role: string;
    createdAt: string;
    updatedAt: string;
    displayName: string;
    avatarUrl: string | null;
    emailVerified: boolean;
}, {
    id: string;
    email: string;
    role: string;
    createdAt: string;
    updatedAt: string;
    displayName: string;
    avatarUrl: string | null;
    emailVerified: boolean;
}>;
export declare const ListUsersQuerySchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
    role: z.ZodOptional<z.ZodString>;
    search: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    search?: string | undefined;
    role?: string | undefined;
}, {
    search?: string | undefined;
    role?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
}>;
export declare const ListUsersResponseSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        email: z.ZodString;
        displayName: z.ZodString;
        avatarUrl: z.ZodNullable<z.ZodString>;
        role: z.ZodString;
        emailVerified: z.ZodBoolean;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        email: string;
        role: string;
        createdAt: string;
        updatedAt: string;
        displayName: string;
        avatarUrl: string | null;
        emailVerified: boolean;
    }, {
        id: string;
        email: string;
        role: string;
        createdAt: string;
        updatedAt: string;
        displayName: string;
        avatarUrl: string | null;
        emailVerified: boolean;
    }>, "many">;
    total: z.ZodNumber;
    limit: z.ZodNumber;
    offset: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    items: {
        id: string;
        email: string;
        role: string;
        createdAt: string;
        updatedAt: string;
        displayName: string;
        avatarUrl: string | null;
        emailVerified: boolean;
    }[];
    total: number;
}, {
    limit: number;
    offset: number;
    items: {
        id: string;
        email: string;
        role: string;
        createdAt: string;
        updatedAt: string;
        displayName: string;
        avatarUrl: string | null;
        emailVerified: boolean;
    }[];
    total: number;
}>;
export declare const UpdateUserRoleBodySchema: z.ZodObject<{
    role: z.ZodEnum<["user", "editor", "moderator", "admin"]>;
}, "strip", z.ZodTypeAny, {
    role: "admin" | "editor" | "moderator" | "user";
}, {
    role: "admin" | "editor" | "moderator" | "user";
}>;
export declare const AdminStatsSchema: z.ZodObject<{
    videos: z.ZodObject<{
        total: z.ZodNumber;
        featured: z.ZodNumber;
        bySource: z.ZodRecord<z.ZodString, z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        featured: number;
        total: number;
        bySource: Record<string, number>;
    }, {
        featured: number;
        total: number;
        bySource: Record<string, number>;
    }>;
    users: z.ZodObject<{
        total: z.ZodNumber;
        byRole: z.ZodRecord<z.ZodString, z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        total: number;
        byRole: Record<string, number>;
    }, {
        total: number;
        byRole: Record<string, number>;
    }>;
    playlists: z.ZodObject<{
        total: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        total: number;
    }, {
        total: number;
    }>;
    schedule: z.ZodObject<{
        total: z.ZodNumber;
        active: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        total: number;
        active: number;
    }, {
        total: number;
        active: number;
    }>;
    notifications: z.ZodObject<{
        sentLast24h: z.ZodNumber;
        sentTotal: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        sentLast24h: number;
        sentTotal: number;
    }, {
        sentLast24h: number;
        sentTotal: number;
    }>;
    broadcast: z.ZodObject<{
        queueDepth: z.ZodNumber;
        activeQueueDepth: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        queueDepth: number;
        activeQueueDepth: number;
    }, {
        queueDepth: number;
        activeQueueDepth: number;
    }>;
    devices: z.ZodObject<{
        total: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        total: number;
    }, {
        total: number;
    }>;
    generatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    playlists: {
        total: number;
    };
    users: {
        total: number;
        byRole: Record<string, number>;
    };
    videos: {
        featured: number;
        total: number;
        bySource: Record<string, number>;
    };
    generatedAt: string;
    broadcast: {
        queueDepth: number;
        activeQueueDepth: number;
    };
    schedule: {
        total: number;
        active: number;
    };
    notifications: {
        sentLast24h: number;
        sentTotal: number;
    };
    devices: {
        total: number;
    };
}, {
    playlists: {
        total: number;
    };
    users: {
        total: number;
        byRole: Record<string, number>;
    };
    videos: {
        featured: number;
        total: number;
        bySource: Record<string, number>;
    };
    generatedAt: string;
    broadcast: {
        queueDepth: number;
        activeQueueDepth: number;
    };
    schedule: {
        total: number;
        active: number;
    };
    notifications: {
        sentLast24h: number;
        sentTotal: number;
    };
    devices: {
        total: number;
    };
}>;
export declare const AnalyticsSchema: z.ZodObject<{
    topVideos: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        viewCount: z.ZodNumber;
        thumbnailUrl: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        title: string;
        id: string;
        thumbnailUrl: string;
        viewCount: number;
    }, {
        title: string;
        id: string;
        thumbnailUrl: string;
        viewCount: number;
    }>, "many">;
    totalViews: z.ZodNumber;
    generatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    generatedAt: string;
    topVideos: {
        title: string;
        id: string;
        thumbnailUrl: string;
        viewCount: number;
    }[];
    totalViews: number;
}, {
    generatedAt: string;
    topVideos: {
        title: string;
        id: string;
        thumbnailUrl: string;
        viewCount: number;
    }[];
    totalViews: number;
}>;
export declare const AnalyticsOverviewSchema: z.ZodObject<{
    totalViews: z.ZodNumber;
    totalSessions: z.ZodNumber;
    completionRate: z.ZodNumber;
    avgWatchSecs: z.ZodNumber;
    platformBreakdown: z.ZodArray<z.ZodObject<{
        platform: z.ZodString;
        sessions: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        platform: string;
        sessions: number;
    }, {
        platform: string;
        sessions: number;
    }>, "many">;
    dailyViews: z.ZodArray<z.ZodObject<{
        date: z.ZodString;
        views: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        date: string;
        views: number;
    }, {
        date: string;
        views: number;
    }>, "many">;
    topVideos: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        viewCount: z.ZodNumber;
        thumbnailUrl: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        title: string;
        id: string;
        thumbnailUrl: string;
        viewCount: number;
    }, {
        title: string;
        id: string;
        thumbnailUrl: string;
        viewCount: number;
    }>, "many">;
    generatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    generatedAt: string;
    platformBreakdown: {
        platform: string;
        sessions: number;
    }[];
    topVideos: {
        title: string;
        id: string;
        thumbnailUrl: string;
        viewCount: number;
    }[];
    totalViews: number;
    totalSessions: number;
    completionRate: number;
    avgWatchSecs: number;
    dailyViews: {
        date: string;
        views: number;
    }[];
}, {
    generatedAt: string;
    platformBreakdown: {
        platform: string;
        sessions: number;
    }[];
    topVideos: {
        title: string;
        id: string;
        thumbnailUrl: string;
        viewCount: number;
    }[];
    totalViews: number;
    totalSessions: number;
    completionRate: number;
    avgWatchSecs: number;
    dailyViews: {
        date: string;
        views: number;
    }[];
}>;
export declare const ConcurrentViewerBucketSchema: z.ZodObject<{
    ts: z.ZodString;
    concurrent: z.ZodNumber;
    tv: z.ZodNumber;
    mobile: z.ZodNumber;
    web: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    mobile: number;
    tv: number;
    web: number;
    ts: string;
    concurrent: number;
}, {
    mobile: number;
    tv: number;
    web: number;
    ts: string;
    concurrent: number;
}>;
export declare const ConcurrentViewersSchema: z.ZodObject<{
    buckets: z.ZodArray<z.ZodObject<{
        ts: z.ZodString;
        concurrent: z.ZodNumber;
        tv: z.ZodNumber;
        mobile: z.ZodNumber;
        web: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        mobile: number;
        tv: number;
        web: number;
        ts: string;
        concurrent: number;
    }, {
        mobile: number;
        tv: number;
        web: number;
        ts: string;
        concurrent: number;
    }>, "many">;
    peak: z.ZodObject<{
        concurrent: z.ZodNumber;
        ts: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        ts: string;
        concurrent: number;
    }, {
        ts: string;
        concurrent: number;
    }>;
    granularity: z.ZodEnum<["hour", "4h", "day"]>;
    generatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    generatedAt: string;
    buckets: {
        mobile: number;
        tv: number;
        web: number;
        ts: string;
        concurrent: number;
    }[];
    peak: {
        ts: string;
        concurrent: number;
    };
    granularity: "hour" | "4h" | "day";
}, {
    generatedAt: string;
    buckets: {
        mobile: number;
        tv: number;
        web: number;
        ts: string;
        concurrent: number;
    }[];
    peak: {
        ts: string;
        concurrent: number;
    };
    granularity: "hour" | "4h" | "day";
}>;
export declare const DailyPlatformBucketSchema: z.ZodObject<{
    date: z.ZodString;
    tv: z.ZodNumber;
    mobile: z.ZodNumber;
    web: z.ZodNumber;
    total: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    date: string;
    mobile: number;
    tv: number;
    web: number;
    total: number;
}, {
    date: string;
    mobile: number;
    tv: number;
    web: number;
    total: number;
}>;
export declare const DailyPlatformTrendsSchema: z.ZodObject<{
    days: z.ZodArray<z.ZodObject<{
        date: z.ZodString;
        tv: z.ZodNumber;
        mobile: z.ZodNumber;
        web: z.ZodNumber;
        total: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        date: string;
        mobile: number;
        tv: number;
        web: number;
        total: number;
    }, {
        date: string;
        mobile: number;
        tv: number;
        web: number;
        total: number;
    }>, "many">;
    generatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    generatedAt: string;
    days: {
        date: string;
        mobile: number;
        tv: number;
        web: number;
        total: number;
    }[];
}, {
    generatedAt: string;
    days: {
        date: string;
        mobile: number;
        tv: number;
        web: number;
        total: number;
    }[];
}>;
