/**
 * Minimal type shim for the `ws` package.
 *
 * ws@8.x does not ship bundled TypeScript declarations and @types/ws is not
 * a declared devDependency.  This shim provides the narrow surface that
 * daemon-proxy.ts actually uses so `tsc --build` succeeds without requiring
 * a lockfile change.  If @types/ws is ever added as a devDependency, delete
 * this file — the installed declarations will take precedence.
 */

/// <reference types="node" />

declare module "ws" {
  import { EventEmitter } from "node:events";

  /** Raw WebSocket message data — mirrors the @types/ws definition. */
  type RawData = Buffer | ArrayBuffer | Buffer[];

  /** Minimal WebSocket client class used by daemon-proxy. */
  class WebSocket extends EventEmitter {
    static readonly OPEN: 1;
    static readonly CONNECTING: 0;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;

    readonly readyState: 0 | 1 | 2 | 3;

    constructor(
      address: string,
      options?: {
        headers?: Record<string, string | string[] | undefined>;
        [key: string]: unknown;
      },
    );

    on(event: "open", listener: () => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;

    send(data: RawData | string, cb?: (err?: Error) => void): void;
    close(code?: number, reason?: string | Buffer): void;
    terminate(): void;
    removeAllListeners(event?: string): this;
  }

  export default WebSocket;
  export type { RawData };
}
