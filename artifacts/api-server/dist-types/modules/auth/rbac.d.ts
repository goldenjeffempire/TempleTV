import type { Role } from "../../shared/types.js";
export declare function hasRole(actual: Role | undefined, required: Role): boolean;
export declare function requireRole(actual: Role | undefined, required: Role): asserts actual is Role;
