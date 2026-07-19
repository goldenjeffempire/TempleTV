export declare function makeHlsToken(_videoId: string): {
    token: string;
    expiresAt: number;
};
export declare function validateHlsToken(_videoId: string, _raw: string): boolean;
export declare function extractHlsVideoId(_url: string): string | null;
export declare function withHlsToken(url: string | null | undefined): string;
