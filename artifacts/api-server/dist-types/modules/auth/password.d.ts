export declare function hashPassword(plain: string): Promise<string>;
export declare function verifyPassword(plain: string, hashed: string): Promise<boolean>;
