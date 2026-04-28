import type { z } from "zod";
import type { CreateMediaBodySchema, ListMediaQuerySchema, SignedUploadBodySchema } from "./media.schemas.js";
export declare const mediaService: {
    list(query: z.infer<typeof ListMediaQuerySchema>): Promise<{
        items: {
            id: string;
            youtubeId: string;
            title: string;
            description: string;
            thumbnailUrl: string;
            duration: string;
            category: string;
            preacher: string;
            publishedAt: string | null;
            importedAt: string;
            viewCount: number;
            featured: boolean;
            videoSource: string;
            localVideoUrl: string | null;
            hlsMasterUrl: string | null;
        }[];
        total: number;
        limit: number;
        offset: number;
    }>;
    getById(id: string): Promise<{
        id: string;
        youtubeId: string;
        title: string;
        description: string;
        thumbnailUrl: string;
        duration: string;
        category: string;
        preacher: string;
        publishedAt: string | null;
        importedAt: string;
        viewCount: number;
        featured: boolean;
        videoSource: string;
        localVideoUrl: string | null;
        hlsMasterUrl: string | null;
    }>;
    create(body: z.infer<typeof CreateMediaBodySchema>): Promise<{
        id: string;
        youtubeId: string;
        title: string;
        description: string;
        thumbnailUrl: string;
        duration: string;
        category: string;
        preacher: string;
        publishedAt: string | null;
        importedAt: string;
        viewCount: number;
        featured: boolean;
        videoSource: string;
        localVideoUrl: string | null;
        hlsMasterUrl: string | null;
    }>;
    delete(id: string): Promise<{
        id: string;
        deleted: boolean;
    }>;
    incrementViewCount(id: string): Promise<void>;
    createSignedUpload(body: z.infer<typeof SignedUploadBodySchema>): Promise<{
        key: string;
        url: string;
        expiresIn: number;
    }>;
};
