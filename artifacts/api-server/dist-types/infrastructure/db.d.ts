import * as schema from "@workspace/db/schema";
export declare const db: import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema> & {
    $client: import("pg").Pool;
};
export { schema };
export type Database = typeof db;
export declare function closeDb(): Promise<void>;
