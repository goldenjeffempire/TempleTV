/**
 * Cross-cutting type aliases shared by modules.
 */
export type Role = "admin" | "editor" | "user" | "system";
export interface AuthenticatedPrincipal {
    id: string;
    email: string;
    role: Role;
}
export declare const ALL_ROLES: readonly ["admin", "editor", "user", "system"];
