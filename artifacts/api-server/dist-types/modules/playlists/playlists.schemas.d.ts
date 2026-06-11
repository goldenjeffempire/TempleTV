import { z } from "zod";
export declare const PlaylistSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    loopMode: z.ZodString;
    isActive: z.ZodBoolean;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    videoCount: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    id: string;
    description: string;
    name: string;
    updatedAt: string;
    createdAt: string;
    loopMode: string;
    isActive: boolean;
    videoCount: number;
}, {
    id: string;
    description: string;
    name: string;
    updatedAt: string;
    createdAt: string;
    loopMode: string;
    isActive: boolean;
    videoCount: number;
}>;
export declare const PlaylistVideoSchema: z.ZodObject<{
    id: z.ZodString;
    playlistId: z.ZodString;
    videoId: z.ZodString;
    youtubeId: z.ZodString;
    title: z.ZodString;
    thumbnailUrl: z.ZodString;
    duration: z.ZodString;
    category: z.ZodString;
    sortOrder: z.ZodNumber;
    addedAt: z.ZodString;
    youtubeLiveStatus: z.ZodOptional<z.ZodNullable<z.ZodEnum<["live", "rebroadcast"]>>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    title: string;
    thumbnailUrl: string;
    duration: string;
    youtubeId: string;
    category: string;
    videoId: string;
    playlistId: string;
    sortOrder: number;
    addedAt: string;
    youtubeLiveStatus?: "live" | "rebroadcast" | null | undefined;
}, {
    id: string;
    title: string;
    thumbnailUrl: string;
    duration: string;
    youtubeId: string;
    category: string;
    videoId: string;
    playlistId: string;
    sortOrder: number;
    addedAt: string;
    youtubeLiveStatus?: "live" | "rebroadcast" | null | undefined;
}>;
export declare const PlaylistDetailSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    loopMode: z.ZodString;
    isActive: z.ZodBoolean;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    videoCount: z.ZodNumber;
} & {
    videos: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        playlistId: z.ZodString;
        videoId: z.ZodString;
        youtubeId: z.ZodString;
        title: z.ZodString;
        thumbnailUrl: z.ZodString;
        duration: z.ZodString;
        category: z.ZodString;
        sortOrder: z.ZodNumber;
        addedAt: z.ZodString;
        youtubeLiveStatus: z.ZodOptional<z.ZodNullable<z.ZodEnum<["live", "rebroadcast"]>>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        title: string;
        thumbnailUrl: string;
        duration: string;
        youtubeId: string;
        category: string;
        videoId: string;
        playlistId: string;
        sortOrder: number;
        addedAt: string;
        youtubeLiveStatus?: "live" | "rebroadcast" | null | undefined;
    }, {
        id: string;
        title: string;
        thumbnailUrl: string;
        duration: string;
        youtubeId: string;
        category: string;
        videoId: string;
        playlistId: string;
        sortOrder: number;
        addedAt: string;
        youtubeLiveStatus?: "live" | "rebroadcast" | null | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    id: string;
    description: string;
    name: string;
    updatedAt: string;
    createdAt: string;
    loopMode: string;
    isActive: boolean;
    videos: {
        id: string;
        title: string;
        thumbnailUrl: string;
        duration: string;
        youtubeId: string;
        category: string;
        videoId: string;
        playlistId: string;
        sortOrder: number;
        addedAt: string;
        youtubeLiveStatus?: "live" | "rebroadcast" | null | undefined;
    }[];
    videoCount: number;
}, {
    id: string;
    description: string;
    name: string;
    updatedAt: string;
    createdAt: string;
    loopMode: string;
    isActive: boolean;
    videos: {
        id: string;
        title: string;
        thumbnailUrl: string;
        duration: string;
        youtubeId: string;
        category: string;
        videoId: string;
        playlistId: string;
        sortOrder: number;
        addedAt: string;
        youtubeLiveStatus?: "live" | "rebroadcast" | null | undefined;
    }[];
    videoCount: number;
}>;
export declare const ListPlaylistsResponseSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodString;
        loopMode: z.ZodString;
        isActive: z.ZodBoolean;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
        videoCount: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        id: string;
        description: string;
        name: string;
        updatedAt: string;
        createdAt: string;
        loopMode: string;
        isActive: boolean;
        videoCount: number;
    }, {
        id: string;
        description: string;
        name: string;
        updatedAt: string;
        createdAt: string;
        loopMode: string;
        isActive: boolean;
        videoCount: number;
    }>, "many">;
    total: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    items: {
        id: string;
        description: string;
        name: string;
        updatedAt: string;
        createdAt: string;
        loopMode: string;
        isActive: boolean;
        videoCount: number;
    }[];
    total: number;
}, {
    items: {
        id: string;
        description: string;
        name: string;
        updatedAt: string;
        createdAt: string;
        loopMode: string;
        isActive: boolean;
        videoCount: number;
    }[];
    total: number;
}>;
export declare const CreatePlaylistBodySchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    loopMode: z.ZodDefault<z.ZodEnum<["sequential", "shuffle", "single"]>>;
    isActive: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    description: string;
    name: string;
    loopMode: "shuffle" | "sequential" | "single";
    isActive: boolean;
}, {
    name: string;
    description?: string | undefined;
    loopMode?: "shuffle" | "sequential" | "single" | undefined;
    isActive?: boolean | undefined;
}>;
export declare const UpdatePlaylistBodySchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodDefault<z.ZodString>>;
    loopMode: z.ZodOptional<z.ZodDefault<z.ZodEnum<["sequential", "shuffle", "single"]>>>;
    isActive: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    description?: string | undefined;
    name?: string | undefined;
    loopMode?: "shuffle" | "sequential" | "single" | undefined;
    isActive?: boolean | undefined;
}, {
    description?: string | undefined;
    name?: string | undefined;
    loopMode?: "shuffle" | "sequential" | "single" | undefined;
    isActive?: boolean | undefined;
}>;
export declare const AddVideoBodySchema: z.ZodObject<{
    videoId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    videoId: string;
}, {
    videoId: string;
}>;
export declare const ReorderBodySchema: z.ZodObject<{
    videoIds: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    videoIds: string[];
}, {
    videoIds: string[];
}>;
