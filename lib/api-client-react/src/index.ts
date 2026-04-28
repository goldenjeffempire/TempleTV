/**
 * Compatibility shim — see `lib/api-zod/src/index.ts` for the full
 * rationale. This package was deleted on April 2026 and rebuilt from
 * the new OpenAPI spec at `/docs/json`.
 *
 * Every named import (hook, query-key getter, mutation, etc.) resolves
 * to a permissive `any` via a Proxy so the legacy admin/mobile/tv
 * source still type-checks while the migration is in flight. Calls to
 * the stubbed hooks throw a clearly-labeled runtime error so a failing
 * dev surface is obvious rather than silent.
 */
const STUB_MARKER = "@workspace/api-client-react:stub";

function stubHook(name: string): any {
  const fn = (..._args: unknown[]) => {
    return {
      data: undefined,
      error: new Error(
        `[${STUB_MARKER}] '${name}' was invoked but the legacy client is removed. ` +
          `Migrate this call site to the new API at /api/v1.`,
      ),
      isLoading: false,
      isFetching: false,
      isSuccess: false,
      isError: true,
      isPending: false,
      mutate: () => undefined,
      mutateAsync: async () => {
        throw new Error(`[${STUB_MARKER}] '${name}' is not implemented in the stub client.`);
      },
      refetch: async () => undefined,
    };
  };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "name") return name;
      if (prop === Symbol.toPrimitive) return () => `[${STUB_MARKER}:${name}]`;
      return stubHook(`${name}.${String(prop)}`);
    },
  });
}

const handler = {
  get(_target: object, prop: string | symbol): any {
    if (prop === "__esModule") return true;
    if (typeof prop === "symbol") return undefined;
    return stubHook(prop);
  },
};

const root = new Proxy({}, handler) as Record<string, any>;
export default root;
export const __isStub: true = true;
