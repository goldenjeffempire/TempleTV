import type { Role } from "../../shared/types.js";
export interface AccessTokenPayload {
    sub: string;
    email: string;
    role: Role;
    type: "access";
    /** Standard JWT "issued at" claim — seconds since epoch. Present on all
     *  tokens we issue (SignJWT sets it automatically) but typed optional so
     *  the interface stays forward-compatible if a token omits it. */
    iat?: number;
}
export interface RefreshTokenPayload {
    sub: string;
    jti: string;
    type: "refresh";
    /** Standard JWT "issued at" claim — seconds since epoch. Set automatically
     *  by SignJWT. Present on all tokens we issue; optional so the interface
     *  stays forward-compatible if a legacy token omits it. */
    iat?: number;
}
export declare function signAccessToken(p: Omit<AccessTokenPayload, "type">): Promise<string>;
export declare function signRefreshToken(p: Omit<RefreshTokenPayload, "type">): Promise<string>;
export declare function verifyAccessToken(token: string): Promise<AccessTokenPayload>;
export declare function verifyRefreshToken(token: string): Promise<RefreshTokenPayload>;
