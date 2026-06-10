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
    title: string;
    description: string;
    id: string;
    duration: string;
    youtubeId: string | null;
    thumbnailUrl: string;
    localVideoUrl: string | null;
    hlsMasterUrl: string | null;
    videoSource: string;
    category: string;
    preacher: string;
    publishedAt: string | null;
    importedAt: string;
    viewCount: number;
    featured: boolean;
}, {
    title: string;
    description: string;
    id: string;
    duration: string;
    youtubeId: string | null;
    thumbnailUrl: string;
    localVideoUrl: string | null;
    hlsMasterUrl: string | null;
    videoSource: string;
    category: string;
    preacher: string;
    publishedAt: string | null;
    importedAt: string;
    viewCount: number;
    featured: boolean;
}>;
export declare const ListMediaQuerySchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
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
    limit?: number | undefined;
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
        title: string;
        description: string;
        id: string;
        duration: string;
        youtubeId: string | null;
        thumbnailUrl: string;
        localVideoUrl: string | null;
        hlsMasterUrl: string | null;
        videoSource: string;
        category: string;
        preacher: string;
        publishedAt: string | null;
        importedAt: string;
        viewCount: number;
        featured: boolean;
    }, {
        title: string;
        description: string;
        id: string;
        duration: string;
        youtubeId: string | null;
        thumbnailUrl: string;
        localVideoUrl: string | null;
        hlsMasterUrl: string | null;
        videoSource: string;
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
    total: number;
    items: {
        title: string;
        description: string;
        id: string;
        duration: string;
        youtubeId: string | null;
        thumbnailUrl: string;
        localVideoUrl: string | null;
        hlsMasterUrl: string | null;
        videoSource: string;
        category: string;
        preacher: string;
        publishedAt: string | null;
        importedAt: string;
        viewCount: number;
        featured: boolean;
    }[];
}, {
    limit: number;
    offset: number;
    total: number;
    items: {
        title: string;
        description: string;
        id: string;
        duration: string;
        youtubeId: string | null;
        thumbnailUrl: string;
        localVideoUrl: string | null;
        hlsMasterUrl: string | null;
        videoSource: string;
        category: string;
        preacher: string;
        publishedAt: string | null;
        importedAt: string;
        viewCount: number;
        featured: boolean;
    }[];
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
    title: string;
    description: string;
    duration: string;
    youtubeId: string;
    thumbnailUrl: string;
    videoSource: "youtube" | "hls" | "local";
    category: string;
    preacher: string;
    featured: boolean;
    localVideoUrl?: string | null | undefined;
    publishedAt?: string | undefined;
}, {
    title: string;
    youtubeId: string;
    description?: string | undefined;
    duration?: string | undefined;
    thumbnailUrl?: string | undefined;
    localVideoUrl?: string | null | undefined;
    videoSource?: "youtube" | "hls" | "local" | undefined;
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
    description?: string | undefined;
    duration?: string | undefined;
    thumbnailUrl?: string | undefined;
    category?: string | undefined;
    preacher?: string | undefined;
    publishedAt?: string | null | undefined;
    featured?: boolean | undefined;
}, {
    title?: string | undefined;
    description?: string | undefined;
    duration?: string | undefined;
    thumbnailUrl?: string | undefined;
    category?: string | undefined;
    preacher?: string | undefined;
    publishedAt?: string | null | undefined;
    featured?: boolean | undefined;
}>, {
    title?: string | undefined;
    description?: string | undefined;
    duration?: string | undefined;
    thumbnailUrl?: string | undefined;
    category?: string | undefined;
    preacher?: string | undefined;
    publishedAt?: string | null | undefined;
    featured?: boolean | undefined;
}, {
    title?: string | undefined;
    description?: string | undefined;
    duration?: string | undefined;
    thumbnailUrl?: string | undefined;
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
    url: string;
    key: string;
    expiresIn: number;
}, {
    url: string;
    key: string;
    expiresIn: number;
}>;
