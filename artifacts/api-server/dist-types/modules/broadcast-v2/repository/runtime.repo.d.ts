import type { V2Mode } from "../domain/types.js";
export interface RuntimeStateRecord {
    channelId: string;
    mode: V2Mode;
    currentItemId: string | null;
    startedAtMs: number | null;
    offsetMs: number;
    activeOverrideId: string | null;
    sequence: number;
}
export declare const runtimeRepo: {
    load(channelId: string): Promise<RuntimeStateRecord | null>;
    save(rec: RuntimeStateRecord): Promise<void>;
    bumpSequence(channelId: string, next: number): Promise<void>;
};
