"""A minimal Redis-backed fixed-window rate limiter.

Scoped to what Milestone 3 actually needs — brute-force protection on
`/v1/auth/login` — rather than a general-purpose middleware applied
platform-wide. A per-route, per-key limiter is easier to reason about than
a global one and is where rate limiting matters most right now; broader
(e.g. per-API-key request quotas) can build on this same primitive later
without reworking it.
"""

from redis.asyncio import Redis

from app.config import get_settings

_redis_client: Redis | None = None


def get_redis() -> Redis:
    """Lazily-created, process-wide Redis client."""
    global _redis_client
    if _redis_client is None:
        settings = get_settings()
        _redis_client = Redis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


class RateLimitExceeded(Exception):
    """Raised when a caller has exceeded the configured limit for a key."""


async def enforce_rate_limit(key: str, *, limit: int, window_seconds: int) -> None:
    """Raise `RateLimitExceeded` if `key` has been hit more than `limit` times
    within the current `window_seconds` window.

    Fixed-window rather than sliding-window or token-bucket: it allows a
    burst right at a window boundary, which is an acceptable tradeoff for
    "slow down brute-force login attempts" and far simpler to reason about
    than the alternatives — not appropriate for billing-grade quota
    enforcement, but that's not what this is protecting.
    """
    redis = get_redis()
    current = await redis.incr(key)
    if current == 1:
        await redis.expire(key, window_seconds)
    if current > limit:
        raise RateLimitExceeded(f"Rate limit exceeded for '{key}'.")
