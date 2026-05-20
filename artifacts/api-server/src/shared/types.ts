/**
 * Cross-cutting type aliases shared by modules.
 */
export type Role = "admin" | "editor" | "user" | "system";

export interface AuthenticatedPrincipal {
  id: string;
  email: string;
  role: Role;
}

export const ALL_ROLES = ["admin", "editor", "user", "system"] as const satisfies readonly Role[];
