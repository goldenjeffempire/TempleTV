/**
 * Compatibility shim.
 *
 * The real `@workspace/api-zod` package was deleted as part of the
 * full API rebuild (April 2026). The new contract lives in the
 * Fastify server's OpenAPI spec at `/docs/json` — generate fresh
 * clients from there when you need them.
 *
 * This shim exists *only* so that `pnpm install` succeeds across the
 * workspace while the Web/Mobile/TV/Admin packages are migrated to
 * the new client. Every named import resolves to a permissive `any`
 * via a Proxy, so source files compile and Vite/Expo/Next dev servers
 * can boot. Calls into these stubs throw at runtime.
 */
const STUB_MARKER = "@workspace/api-zod:stub";

function makeStub(name: string): any {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => `[${STUB_MARKER}:${name}]`;
      if (prop === "name") return `${name}.${String(prop)}`;
      return makeStub(`${name}.${String(prop)}`);
    },
    apply() {
      throw new Error(
        `[${STUB_MARKER}] '${name}' was called but @workspace/api-zod is a deletion stub. ` +
          `The legacy contract was removed; use the new OpenAPI spec at /docs/json.`,
      );
    },
    construct() {
      throw new Error(`[${STUB_MARKER}] cannot construct '${name}' — this package is a stub.`);
    },
  });
}

const handler = {
  get(_target: object, prop: string | symbol): any {
    if (prop === "__esModule") return true;
    if (typeof prop === "symbol") return undefined;
    return makeStub(prop);
  },
};

const root = new Proxy({}, handler) as Record<string, any>;
export default root;
export const __isStub: true = true;

// Re-export anything the consumer asks for via the dynamic Proxy. Because
// TypeScript can't model "any name resolves", consumers must either rely
// on `import * as X` or add an ambient declaration. Declarations are
// emitted via the ambient module below so direct named imports compile.
