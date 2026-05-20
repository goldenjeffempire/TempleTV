import type { Role } from "../../shared/types.js";
import { ForbiddenError, UnauthorizedError } from "../../shared/errors.js";

/**
 * Role hierarchy (numerically larger = more powerful).
 *   user    : default authenticated viewer
 *   editor  : can create/update media + schedule
 *   admin   : full control
 *   system  : machine-to-machine, never issued to humans
 */
const RANK: Record<Role, number> = { user: 1, editor: 2, admin: 3, system: 4 };

export function hasRole(actual: Role | undefined, required: Role): boolean {
  if (!actual) return false;
  return RANK[actual] >= RANK[required];
}

export function requireRole(
  actual: Role | undefined,
  required: Role,
): asserts actual is Role {
  if (!actual) throw new UnauthorizedError();
  if (!hasRole(actual, required)) {
    throw new ForbiddenError(`Requires role: ${required}`);
  }
}
