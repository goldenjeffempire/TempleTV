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
    displayName: string;
    avatarUrl: string | null;
    role: string;
    emailVerified: boolean;
    createdAt: string;
    updatedAt: string;
}, {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    emailVerified: boolean;
    createdAt: string;
    updatedAt: string;
}>;
export declare const ListUsersQuerySchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
    role: z.ZodOptional<z.ZodString>;
    search: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    role?: string | undefined;
    search?: string | undefined;
}, {
    role?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    search?: string | undefined;
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
        displayName: string;
        avatarUrl: string | null;
        role: string;
        emailVerified: boolean;
        createdAt: string;
        updatedAt: string;
    }, {
        id: string;
        email: string;
        displayName: string;
        avatarUrl: string | null;
        role: string;
        emailVerified: boolean;
        createdAt: string;
        updatedAt: string;
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
        displayName: string;
        avatarUrl: string | null;
        role: string;
        emailVerified: boolean;
        createdAt: string;
        updatedAt: string;
    }[];
    total: number;
}, {
    limit: number;
    offset: number;
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
}>;
export declare const UpdateUserRoleBodySchema: z.ZodObject<{
    role: z.ZodEnum<["user", "editor", "moderator", "admin"]>;
}, "strip", z.ZodTypeAny, {
    role: "user" | "editor" | "moderator" | "admin";
}, {
    role: "user" | "editor" | "moderator" | "admin";
}>;
export declare const AdminStatsSchema: z.ZodObject<{
    videos: z.ZodObject<{
        total: z.ZodNumber;
        featured: z.ZodNumber;
        bySource: z.ZodRecord<z.ZodString, z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        total: number;
        featured: number;
        bySource: Record<string, number>;
    }, {
        total: number;
        featured: number;
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
}, {
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
export declare const AnalyticsSchema: z.ZodObject<{
    topVideos: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        viewCount: z.ZodNumber;
        thumbnailUrl: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        title: string;
        viewCount: number;
        thumbnailUrl: string;
    }, {
        id: string;
        title: string;
        viewCount: number;
        thumbnailUrl: string;
    }>, "many">;
    totalViews: z.ZodNumber;
    generatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    generatedAt: string;
    topVideos: {
        id: string;
        title: string;
        viewCount: number;
        thumbnailUrl: string;
    }[];
    totalViews: number;
}, {
    generatedAt: string;
    topVideos: {
        id: string;
        title: string;
        viewCount: number;
        thumbnailUrl: string;
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
        id: string;
        title: string;
        viewCount: number;
        thumbnailUrl: string;
    }, {
        id: string;
        title: string;
        viewCount: number;
        thumbnailUrl: string;
    }>, "many">;
    generatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    generatedAt: string;
    topVideos: {
        id: string;
        title: string;
        viewCount: number;
        thumbnailUrl: string;
    }[];
    totalViews: number;
    totalSessions: number;
    completionRate: number;
    avgWatchSecs: number;
    platformBreakdown: {
        platform: string;
        sessions: number;
    }[];
    dailyViews: {
        date: string;
        views: number;
    }[];
}, {
    generatedAt: string;
    topVideos: {
        id: string;
        title: string;
        viewCount: number;
        thumbnailUrl: string;
    }[];
    totalViews: number;
    totalSessions: number;
    completionRate: number;
    avgWatchSecs: number;
    platformBreakdown: {
        platform: string;
        sessions: number;
    }[];
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
    ts: string;
    concurrent: number;
    tv: number;
    mobile: number;
    web: number;
}, {
    ts: string;
    concurrent: number;
    tv: number;
    mobile: number;
    web: number;
}>;
export declare const ConcurrentViewersSchema: z.ZodObject<{
    buckets: z.ZodArray<z.ZodObject<{
        ts: z.ZodString;
        concurrent: z.ZodNumber;
        tv: z.ZodNumber;
        mobile: z.ZodNumber;
        web: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        ts: string;
        concurrent: number;
        tv: number;
        mobile: number;
        web: number;
    }, {
        ts: string;
        concurrent: number;
        tv: number;
        mobile: number;
        web: number;
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
        ts: string;
        concurrent: number;
        tv: number;
        mobile: number;
        web: number;
    }[];
    peak: {
        ts: string;
        concurrent: number;
    };
    granularity: "hour" | "4h" | "day";
}, {
    generatedAt: string;
    buckets: {
        ts: string;
        concurrent: number;
        tv: number;
        mobile: number;
        web: number;
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
    total: number;
    tv: number;
    mobile: number;
    web: number;
}, {
    date: string;
    total: number;
    tv: number;
    mobile: number;
    web: number;
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
        total: number;
        tv: number;
        mobile: number;
        web: number;
    }, {
        date: string;
        total: number;
        tv: number;
        mobile: number;
        web: number;
    }>, "many">;
    generatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    generatedAt: string;
    days: {
        date: string;
        total: number;
        tv: number;
        mobile: number;
        web: number;
    }[];
}, {
    generatedAt: string;
    days: {
        date: string;
        total: number;
        tv: number;
        mobile: number;
        web: number;
    }[];
}>;
