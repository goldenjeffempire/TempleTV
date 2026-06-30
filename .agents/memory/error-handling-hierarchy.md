---
name: Error handling hierarchy and AppError classification
description: Rules for which AppError subclass to throw, and how the error handler classifies raw errors into HTTP status codes.
---

## AppError subclasses and their HTTP codes

| Class | Status | Code | When to use |
|---|---|---|---|
| BadRequestError | 400 | BAD_REQUEST | Invalid client input, missing required field |
| UnauthorizedError | 401 | UNAUTHORIZED | Missing/invalid JWT |
| ForbiddenError | 403 | FORBIDDEN | Authenticated but insufficient role |
| NotFoundError | 404 | NOT_FOUND | Row/resource not found |
| ConflictError | 409 | CONFLICT | Duplicate key, "already in progress" guards |
| UnprocessableEntityError | 422 | UNPROCESSABLE_ENTITY | Well-formed but semantically invalid |
| TooManyRequestsError | 429 | RATE_LIMITED | Custom rate limit logic |
| InternalError | 500 | INTERNAL | Server bugs, DB insert returning no rows |
| BadGatewayError | 502 | BAD_GATEWAY | Upstream (YouTube, GitHub, EAS) unreachable |
| ServiceUnavailableError | 503 | SERVICE_UNAVAILABLE | Capacity/circuit-open, planned maintenance |
| GatewayTimeoutError | 504 | GATEWAY_TIMEOUT | AbortError, ETIMEDOUT from upstream |

## Network error auto-classification in error-handler.ts

`classifyRawError()` in `error-handler.ts` fires BEFORE the generic 500 path:
- `AbortError` / `TimeoutError` → 504 GatewayTimeout
- `ETIMEDOUT` / `ESOCKETTIMEDOUT` / `ECONNABORTED` → 504 GatewayTimeout  
- `ECONNREFUSED` / `ECONNRESET` / `ENOTFOUND` / `EAI_AGAIN` / `EHOSTUNREACH` / `ENETUNREACH` → 502 BadGateway

This means external service call failures automatically get the right status code even if the calling route doesn't have explicit catch logic.

## Concurrency guards should use ConflictError (409)

"A sync is already in progress" / "operation already running" → `ConflictError`, NOT raw `new Error()`.
The old pattern returned 500; 409 is correct (client can retry when free).

## classifyError() helper

`shared/errors.ts` exports `classifyError(err, context?)` — use this in service-layer catch blocks to convert caught raw errors to the nearest AppError subclass before re-throwing, without leaking internal codes.

**Why:** Prevents upstream network failures from appearing as 500 on monitoring dashboards. Clients get actionable status codes (502/503/504) instead of opaque 500s.
