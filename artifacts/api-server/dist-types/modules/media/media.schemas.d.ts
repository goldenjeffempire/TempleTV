import { z } from "zod";
export declare const MediaItemSchema: z.ZodObject<{
    id: z.ZodString;
    youtubeId: z.ZodNullable<z.ZodString>;
    title: z.ZodString;
    description: z.ZodString;
    thumbnailUrl: z.ZodString;
    duration: z.ZodString;
    category: z.ZodString;
    preacher: z.ZodString;
    publishedAt: z.ZodNullable<z.ZodString>;
    importedAt: z.ZodString;
    viewCount: z.ZodNumber;
    featured: z.ZodBoolean;
    videoSource: z.ZodString;
    localVideoUrl: z.ZodNullable<z.ZodString>;
    hlsMasterUrl: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    youtubeId: string | null;
    title: string;
    thumbnailUrl: string;
    localVideoUrl: string | null;
    hlsMasterUrl: string | null;
    videoSource: string;
    duration: string;
    description: string;
    category: string;
    preacher: string;
    publishedAt: string | null;
    importedAt: string;
    viewCount: number;
    featured: boolean;
}, {
    id: string;
    youtubeId: string | null;
    title: string;
    thumbnailUrl: string;
    localVideoUrl: string | null;
    hlsMasterUrl: string | null;
    videoSource: string;
    duration: string;
    description: string;
    category: string;
    preacher: string;
    publishedAt: string | null;
    importedAt: string;
    viewCount: number;
    featured: boolean;
}>;
export declare const ListMediaQuerySchema: z.ZodObject<{
    limit: z.ZodEffects<z.ZodCatch<z.ZodDefault<z.ZodNumber>>, number, unknown>;
    offset: z.ZodDefault<z.ZodNumber>;
    category: z.ZodOptional<z.ZodString>;
    featured: z.ZodOptional<z.ZodBoolean>;
    search: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    search?: string | undefined;
    category?: string | undefined;
    featured?: boolean | undefined;
}, {
    search?: string | undefined;
    category?: string | undefined;
    featured?: boolean | undefined;
    limit?: unknown;
    offset?: number | undefined;
}>;
export declare const ListMediaResponseSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        youtubeId: z.ZodNullable<z.ZodString>;
        title: z.ZodString;
        description: z.ZodString;
        thumbnailUrl: z.ZodString;
        duration: z.ZodString;
        category: z.ZodString;
        preacher: z.ZodString;
        publishedAt: z.ZodNullable<z.ZodString>;
        importedAt: z.ZodString;
        viewCount: z.ZodNumber;
        featured: z.ZodBoolean;
        videoSource: z.ZodString;
        localVideoUrl: z.ZodNullable<z.ZodString>;
        hlsMasterUrl: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        youtubeId: string | null;
        title: string;
        thumbnailUrl: string;
        localVideoUrl: string | null;
        hlsMasterUrl: string | null;
        videoSource: string;
        duration: string;
        description: string;
        category: string;
        preacher: string;
        publishedAt: string | null;
        importedAt: string;
        viewCount: number;
        featured: boolean;
    }, {
        id: string;
        youtubeId: string | null;
        title: string;
        thumbnailUrl: string;
        localVideoUrl: string | null;
        hlsMasterUrl: string | null;
        videoSource: string;
        duration: string;
        description: string;
        category: string;
        preacher: string;
        publishedAt: string | null;
        importedAt: string;
        viewCount: number;
        featured: boolean;
    }>, "many">;
    total: z.ZodNumber;
    limit: z.ZodNumber;
    offset: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    items: {
        id: string;
        youtubeId: string | null;
        title: string;
        thumbnailUrl: string;
        localVideoUrl: string | null;
        hlsMasterUrl: string | null;
        videoSource: string;
        duration: string;
        description: string;
        category: string;
        preacher: string;
        publishedAt: string | null;
        importedAt: string;
        viewCount: number;
        featured: boolean;
    }[];
    total: number;
}, {
    limit: number;
    offset: number;
    items: {
        id: string;
        youtubeId: string | null;
        title: string;
        thumbnailUrl: string;
        localVideoUrl: string | null;
        hlsMasterUrl: string | null;
        videoSource: string;
        duration: string;
        description: string;
        category: string;
        preacher: string;
        publishedAt: string | null;
        importedAt: string;
        viewCount: number;
        featured: boolean;
    }[];
    total: number;
}>;
export declare const CreateMediaBodySchema: z.ZodObject<{
    youtubeId: z.ZodString;
    title: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    thumbnailUrl: z.ZodDefault<z.ZodString>;
    duration: z.ZodDefault<z.ZodString>;
    category: z.ZodDefault<z.ZodString>;
    preacher: z.ZodDefault<z.ZodString>;
    videoSource: z.ZodDefault<z.ZodEnum<["youtube", "local", "hls"]>>;
    localVideoUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    featured: z.ZodDefault<z.ZodBoolean>;
    publishedAt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    videoSource: "youtube" | "local" | "hls";
    duration: string;
    description: string;
    category: string;
    preacher: string;
    featured: boolean;
    localVideoUrl?: string | null | undefined;
    publishedAt?: string | undefined;
}, {
    youtubeId: string;
    title: string;
    thumbnailUrl?: string | undefined;
    localVideoUrl?: string | null | undefined;
    videoSource?: "youtube" | "local" | "hls" | undefined;
    duration?: string | undefined;
    description?: string | undefined;
    category?: string | undefined;
    preacher?: string | undefined;
    publishedAt?: string | undefined;
    featured?: boolean | undefined;
}>;
export declare const UpdateMediaBodySchema: z.ZodEffects<z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    thumbnailUrl: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodString>;
    category: z.ZodOptional<z.ZodString>;
    preacher: z.ZodOptional<z.ZodString>;
    featured: z.ZodOptional<z.ZodBoolean>;
    publishedAt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    title?: string | undefined;
    thumbnailUrl?: string | undefined;
    duration?: string | undefined;
    description?: string | undefined;
    category?: string | undefined;
    preacher?: string | undefined;
    publishedAt?: string | null | undefined;
    featured?: boolean | undefined;
}, {
    title?: string | undefined;
    thumbnailUrl?: string | undefined;
    duration?: string | undefined;
    description?: string | undefined;
    category?: string | undefined;
    preacher?: string | undefined;
    publishedAt?: string | null | undefined;
    featured?: boolean | undefined;
}>, {
    title?: string | undefined;
    thumbnailUrl?: string | undefined;
    duration?: string | undefined;
    description?: string | undefined;
    category?: string | undefined;
    preacher?: string | undefined;
    publishedAt?: string | null | undefined;
    featured?: boolean | undefined;
}, {
    title?: string | undefined;
    thumbnailUrl?: string | undefined;
    duration?: string | undefined;
    description?: string | undefined;
    category?: string | undefined;
    preacher?: string | undefined;
    publishedAt?: string | null | undefined;
    featured?: boolean | undefined;
}>;
export declare const SignedUploadBodySchema: z.ZodObject<{
    filename: z.ZodString;
    contentType: z.ZodString;
    sizeBytes: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    sizeBytes: number;
    contentType: string;
    filename: string;
}, {
    sizeBytes: number;
    contentType: string;
    filename: string;
}>;
export declare const SignedUploadResponseSchema: z.ZodObject<{
    key: z.ZodString;
    url: z.ZodString;
    expiresIn: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    key: string;
    url: string;
    expiresIn: number;
}, {
    key: string;
    url: string;
    expiresIn: number;
}>;
