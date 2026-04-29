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
    loopMode: string;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
    videoCount: number;
}, {
    id: string;
    description: string;
    name: string;
    loopMode: string;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
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
}, "strip", z.ZodTypeAny, {
    id: string;
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    duration: string;
    category: string;
    playlistId: string;
    videoId: string;
    sortOrder: number;
    addedAt: string;
}, {
    id: string;
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    duration: string;
    category: string;
    playlistId: string;
    videoId: string;
    sortOrder: number;
    addedAt: string;
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
    }, "strip", z.ZodTypeAny, {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        duration: string;
        category: string;
        playlistId: string;
        videoId: string;
        sortOrder: number;
        addedAt: string;
    }, {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        duration: string;
        category: string;
        playlistId: string;
        videoId: string;
        sortOrder: number;
        addedAt: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    id: string;
    description: string;
    name: string;
    loopMode: string;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
    videos: {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        duration: string;
        category: string;
        playlistId: string;
        videoId: string;
        sortOrder: number;
        addedAt: string;
    }[];
    videoCount: number;
}, {
    id: string;
    description: string;
    name: string;
    loopMode: string;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
    videos: {
        id: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        duration: string;
        category: string;
        playlistId: string;
        videoId: string;
        sortOrder: number;
        addedAt: string;
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
        loopMode: string;
        isActive: boolean;
        createdAt: string;
        updatedAt: string;
        videoCount: number;
    }, {
        id: string;
        description: string;
        name: string;
        loopMode: string;
        isActive: boolean;
        createdAt: string;
        updatedAt: string;
        videoCount: number;
    }>, "many">;
    total: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    total: number;
    items: {
        id: string;
        description: string;
        name: string;
        loopMode: string;
        isActive: boolean;
        createdAt: string;
        updatedAt: string;
        videoCount: number;
    }[];
}, {
    total: number;
    items: {
        id: string;
        description: string;
        name: string;
        loopMode: string;
        isActive: boolean;
        createdAt: string;
        updatedAt: string;
        videoCount: number;
    }[];
}>;
export declare const CreatePlaylistBodySchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    loopMode: z.ZodDefault<z.ZodEnum<["sequential", "shuffle", "single"]>>;
    isActive: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    description: string;
    name: string;
    loopMode: "single" | "sequential" | "shuffle";
    isActive: boolean;
}, {
    name: string;
    description?: string | undefined;
    loopMode?: "single" | "sequential" | "shuffle" | undefined;
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
    loopMode?: "single" | "sequential" | "shuffle" | undefined;
    isActive?: boolean | undefined;
}, {
    description?: string | undefined;
    name?: string | undefined;
    loopMode?: "single" | "sequential" | "shuffle" | undefined;
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
