/**
 * Security configuration constants and helpers.
 */
/**
 * Production-only security features that should be enabled.
 */
export declare const isProd: () => boolean;
export declare const isDev: () => boolean;
/**
 * Rate limiting configuration per route group.
 * Values are [requests per minute, timeWindow in minutes].
 */
export declare const rateLimitConfig: {
    auth: {
        max: number;
        timeWindow: string;
    };
    admin: {
        max: number;
        timeWindow: string;
    };
    media: {
        max: number;
        timeWindow: string;
    };
    youtube: {
        max: number;
        timeWindow: string;
    };
    default: {
        max: number;
        timeWindow: string;
    };
};
/**
 * Security headers configuration.
 */
export declare const securityHeaders: {
    hsts: {
        maxAge: number;
        includeSubDomains: boolean;
        preload: boolean;
    };
    cors: {
        credentials: boolean;
        methods: string[];
        allowedHeaders: string[];
        exposedHeaders: string[];
        maxAge: number;
    };
    csrf: {
        headerName: string;
        headerValue: string;
    };
};
/**
 * ADMIN_API_TOKEN security configuration.
 */
export declare const adminTokenConfig: {
    defaultRole: "editor";
    minLength: number;
    auditLogging: boolean;
};
