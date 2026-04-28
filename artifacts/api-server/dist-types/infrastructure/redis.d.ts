import { Redis } from "ioredis";
export declare function getRedis(): Redis | null;
export declare function closeRedis(): Promise<void>;
