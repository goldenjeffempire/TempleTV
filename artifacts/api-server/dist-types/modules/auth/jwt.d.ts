import type { Role } from "../../shared/types.js";
export interface AccessTokenPayload {
    sub: string;
    email: string;
    role: Role;
    type: "access";
}
export interface RefreshTokenPayload {
    sub: string;
    jti: string;
    type: "refresh";
}
export declare function signAccessToken(p: Omit<AccessTokenPayload, "type">): string;
export declare function signRefreshToken(p: Omit<RefreshTokenPayload, "type">): string;
export declare function verifyAccessToken(token: string): AccessTokenPayload;
export declare function verifyRefreshToken(token: string): RefreshTokenPayload;
