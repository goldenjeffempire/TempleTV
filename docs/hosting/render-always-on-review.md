# Always-on Render API — review only

**Status: proposed, not applied.** Preparing this document and patch does not
change Render services, deploy code, upgrade a plan, or start billing.
The active `render.yaml` remains unchanged by this proposal.

## Exact proposed change

Apply `render-always-on.review.patch` to the existing API service only:

```diff
 name: temple-tv-api
-plan: free
+plan: 0.5c-512mb
```

The current Render Blueprint reference lists `0.5c-512mb` for 0.5 CPU / 512 MB.
This is the smallest paid compute option listed in the current reference.
Do not substitute an older plan nickname without checking Render's current
validation and the existing service's settings.

| Component | Proposed action |
| --- | --- |
| API | Move from configured Free to paid, always-on 0.5 CPU / 512 MB |
| Private broadcast daemon | Leave existing plan, identity and process configuration unchanged |
| Admin, mobile web and TV sites | Leave existing static hosting unchanged |
| Database, media storage and optional Redis | Keep existing providers, wiring and data |
| Secrets, domains, CORS, region and ports | No changes |
| Memory limits, database pools, migrations and health checks | No changes |
| Replicas / autoscaling | No changes |

The API/daemon private-network `fromService` references must remain intact.
Do not create a second daemon, move the engine back into the API, add a keepalive
bot, or use admin connections as a way to prevent service sleep.

## Cost and capacity

Render's published compute price, checked **2026-11-12**, is **US$7/month**
for `0.5c-512mb`. If the live API is still Free, this introduces a paid API
compute charge. Actual billing depends on Render's current terms and usage.
This is not the total station cost: existing daemon, database, workspace,
build, bandwidth/egress, optional Redis, and tax charges are separate.
Confirm the actual live API plan and the price displayed in Render before
authorizing anything.

**This is an idle-sleep fix, not a capacity upgrade.** It retains 512 MB.
Historical out-of-memory incidents and production video-serving load still need
validation. If testing requires more headroom, Render currently lists
`1c-2g` (1 CPU / 2 GB) at **US$25/month** for API compute. That is a separate
capacity decision, not included in this patch; increasing RAM also requires
reviewing the application's existing heap/watchdog limits.

No claim is made that the smallest paid plan can support the station's target
concurrency. Paid hosting is not a 100% uptime guarantee.

## Review and application procedure

1. Confirm which live API service is managed by the existing Blueprint, its
   current compute plan, and that API/daemon share the intended workspace and
   region. Repository settings alone do not prove live settings.
2. Review the proposed incremental cost and the 512 MB capacity limitation.
3. Validate the patch without applying it:

   ```sh
   git apply --check docs/hosting/render-always-on.review.patch
   ```

4. **Only after separate approval**, apply the repository change:

   ```sh
   git apply docs/hosting/render-always-on.review.patch
   ```

   Applying a local patch is not a deployment or a hosting-plan change.
   Do not run it automatically just because this document exists.
5. Have the operator review the **entire** pending Render Blueprint diff before
   syncing the existing Blueprint or changing the existing API's compute plan.
   Other pending repository changes may also appear. Do not create a new
   Blueprint from this patch. Stop if Render proposes duplicate/recreated
   services, daemon replacement, database/storage changes, secret regeneration,
   or unrelated paid additions.
6. Schedule any resize/API restart as a media-delivery maintenance risk. The
   broadcast daemon should remain running, but fresh media requests still
   depend on the API. Do not silently deploy other pending backend changes.
7. Record the approved plan, actual deployed settings and observed results.
   No automated plan downgrade or code rollback is authorized by this proposal.

## Acceptance after an authorized staging rollout

- Confirm the API does not idle-spin-down after more than 15 minutes without
  HTTP requests or WebSocket traffic. Do not use a monitoring/keepalive request
  stream that invalidates that observation.
- Independently observe daemon identity, leadership, queue/session anchor and
  recovery. Verify no second broadcast leader is created.
- Use a separate audience client with real uploaded broadcast media. Close,
  log out and disconnect the admin; verify actual audio/video continues.
- Test API/WebSocket recovery and explicitly measure any fresh-media
  interruption caused by an API process outage.
- Validate authenticated admin reconnection, accurate audience counts,
  current/next information and fresh synchronization.
- Measure RSS/heap/external buffers, DB pool waits, range-request correctness,
  response latency and errors under representative simultaneous viewing and
  upload load. Stop or resize through a separately approved capacity plan if
  512 MB is insufficient.
- Complete supported installed-Android playback checks and a controlled soak.

## Remaining availability boundary

Paid always-on API compute removes Free-tier idle sleep; it does not separate
media delivery from API failures. The daemon can maintain its clock while new
media byte-range requests fail. Independent delivery/CDN architecture needs its
own reviewed design, storage compatibility checks, costs and validation.
This proposal does not migrate the database or replace PostgreSQL media storage.

## Official references

- Pricing: https://render.com/pricing
- Current compute identifiers: https://render.com/docs/blueprint-spec
- Free-service spin-down and restrictions: https://render.com/docs/free

See `../admin-continuity-validation.md` and
`../admin-broadcast-continuity-runbook.md` for completed development checks and
remaining production gates.
