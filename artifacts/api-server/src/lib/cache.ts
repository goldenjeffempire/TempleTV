import { logger } from "./logger";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private gcInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.gcInterval = setInterval(() => this.gc(), 60_000);
    this.gcInterval.unref?.();
  }

  private gc() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  flush(): void {
    this.store.clear();
  }
}

class RedisCache {
  private client: import("ioredis").Redis;
  private ready = false;

  constructor(url: string) {
    import("ioredis").then(({ default: Redis }) => {
      this.client = new Redis(url, {
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: true,
        connectTimeout: 4000,
        commandTimeout: 3000,
      });

      this.client.on("connect", () => {
        this.ready = true;
        logger.info("Redis connected");
      });

      this.client.on("error", (err: Error) => {
        if (this.ready) logger.warn({ err: err.message }, "Redis error — falling back to memory");
        this.ready = false;
      });

      this.client.connect().catch(() => {
        logger.warn("Redis connect failed — in-memory cache active");
      });
    }).catch(() => {
      logger.warn("ioredis not available");
    });
  }

  isReady() {
    return this.ready;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.ready) return null;
    try {
      const raw = await this.client.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (!this.ready) return;
    try {
      await this.client.set(key, JSON.stringify(value), "PX", ttlMs);
    } catch {}
  }

  async del(key: string): Promise<void> {
    if (!this.ready) return;
    try {
      await this.client.del(key);
    } catch {}
  }
}

const memoryCache = new MemoryCache();
const redisCache = process.env.REDIS_URL ? new RedisCache(process.env.REDIS_URL) : null;

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    if (redisCache?.isReady()) {
      const val = await redisCache.get<T>(key);
      if (val !== null) return val;
    }
    return memoryCache.get<T>(key);
  },

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    memoryCache.set(key, value, ttlMs);
    if (redisCache?.isReady()) {
      await redisCache.set(key, value, ttlMs);
    }
  },

  async del(key: string): Promise<void> {
    memoryCache.del(key);
    if (redisCache?.isReady()) {
      await redisCache.del(key);
    }
  },

  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlMs: number,
  ): Promise<T> {
    const cached = await cache.get<T>(key);
    if (cached !== null) return cached;
    const fresh = await fetcher();
    await cache.set(key, fresh, ttlMs);
    return fresh;
  },

  isRedisActive(): boolean {
    return redisCache?.isReady() ?? false;
  },

  status() {
    return {
      redis: {
        configured: Boolean(process.env.REDIS_URL),
        connected: redisCache?.isReady() ?? false,
      },
      memory: {
        active: true,
      },
    };
  },
};
