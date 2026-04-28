import type { Role } from "../../shared/types.js";
import type { AuthTokens, LoginBody, RegisterBody } from "./auth.schemas.js";
export declare const authService: {
    register(body: RegisterBody): Promise<AuthTokens>;
    login(body: LoginBody): Promise<AuthTokens>;
    refresh(refreshToken: string): Promise<AuthTokens>;
    logout(refreshToken: string): Promise<void>;
    getProfile(userId: string): Promise<{
        id: string;
        email: string;
        role: Role;
        displayName: string;
        createdAt: string;
    }>;
};
