export interface DaemonHealthPayload {
    ok: boolean;
    mode: string;
    hasCurrent: boolean;
    itemCount: number;
    boot: {
        started: boolean;
    };
    runtime: {
        role: string;
        gitCommit: string | null;
        serviceName: string | null;
        instanceId: string | null;
    };
}
export type DaemonHealthValidation = {
    valid: true;
    payload: DaemonHealthPayload;
} | {
    valid: false;
    reason: string;
};
/**
 * Validate the daemon health response at the API/daemon process boundary.
 *
 * A reachable TCP socket or HTTP 200 is not sufficient: an old daemon build
 * once returned a zero-byte 200 response, which the API forwarded as healthy
 * while the orchestrator remained OFF AIR. Requiring the runtime identity and
 * core playback fields prevents that failure from being masked again.
 */
export declare function validateDaemonHealthBody(rawBody: string): DaemonHealthValidation;
