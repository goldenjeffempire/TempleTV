import type { z } from "zod";
import type { CreatePlaylistBodySchema, UpdatePlaylistBodySchema } from "./playlists.schemas.js";
export declare const playlistsService: {
    list(): Promise<{
        items: {
            id: string;
            name: string;
            description: string;
            loopMode: string;
            isActive: boolean;
            createdAt: string;
            updatedAt: string;
            videoCount: number;
        }[];
        total: number;
    }>;
    getById(id: string): Promise<{
        videos: {
            id: string;
            playlistId: string;
            videoId: string;
            youtubeId: string;
            title: string;
            thumbnailUrl: string;
            duration: string;
            category: string;
            sortOrder: number;
            addedAt: string;
            youtubeLiveStatus: "live" | "rebroadcast" | null;
        }[];
        id: string;
        name: string;
        description: string;
        loopMode: string;
        isActive: boolean;
        createdAt: string;
        updatedAt: string;
        videoCount: number;
    }>;
    create(body: z.infer<typeof CreatePlaylistBodySchema>): Promise<{
        id: string;
        name: string;
        description: string;
        loopMode: string;
        isActive: boolean;
        createdAt: string;
        updatedAt: string;
        videoCount: number;
    }>;
    update(id: string, body: z.infer<typeof UpdatePlaylistBodySchema>): Promise<{
        id: string;
        name: string;
        description: string;
        loopMode: string;
        isActive: boolean;
        createdAt: string;
        updatedAt: string;
        videoCount: number;
    }>;
    delete(id: string): Promise<{
        id: string;
        deleted: boolean;
    }>;
    addVideo(playlistId: string, videoId: string): Promise<{
        id: string;
        playlistId: string;
        videoId: string;
        youtubeId: string;
        title: string;
        thumbnailUrl: string;
        duration: string;
        category: string;
        sortOrder: number;
        addedAt: string;
        youtubeLiveStatus: "live" | "rebroadcast" | null;
    }>;
    removeVideo(playlistId: string, playlistVideoId: string): Promise<{
        id: string;
        deleted: boolean;
    }>;
    reorder(playlistId: string, videoIds: string[]): Promise<{
        videos: {
            id: string;
            playlistId: string;
            videoId: string;
            youtubeId: string;
            title: string;
            thumbnailUrl: string;
            duration: string;
            category: string;
            sortOrder: number;
            addedAt: string;
            youtubeLiveStatus: "live" | "rebroadcast" | null;
        }[];
        id: string;
        name: string;
        description: string;
        loopMode: string;
        isActive: boolean;
        createdAt: string;
        updatedAt: string;
        videoCount: number;
    }>;
};
