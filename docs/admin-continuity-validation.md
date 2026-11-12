# Admin and broadcast continuity validation

Status: development verification; production sign-off remains gated.

## Automated and build checks

- API, admin, and mobile TypeScript checks passed.
- Admin and API production builds passed.
- The named `test:admin-continuity` command passed 21 actual Node tests,
  with no failures or skipped tests. Coverage includes observer transport and
  mutation isolation, bounded natural-end retries, authoritative daemon status,
  failure-cache recovery, readiness, SSE cleanup, and historical repair outcomes.
- All three changed player-core files match their mobile vendor counterparts.
- The actual development asset-health rows validate against the response schema;
  historical `blocked` repair outcomes are preserved, not deleted or relabeled.
- The workspace currently runs Node 20 although the project requests Node 22+.
  Successful workspace checks do not replace the configured production toolchain.

## Completed development browser/process checks

One browser journey used only the managed admin preview and local API/daemon.
Temporary test accounts and refresh tokens were removed after testing.

| Scenario | Observed result |
| --- | --- |
| Browser offline for 15 seconds | Dashboard offline indicator appeared; station remained on air |
| Refresh | Authentication persisted and dashboard recovered |
| Logout/login | Successful; station's clock anchor was not reset |
| Second authenticated tab | Console count changed 1 → 2 → 1 after closing it |
| Desktop and 390px phone | Navigation and account controls worked; no document horizontal overflow |
| Real development daemon SIGKILL | Restart restored the same item/start anchor with advancing position; one daemon observed |
| Closing the admin tab | Independent port-9000 observer continued to see the same authoritative anchor and advancing position |
| API process restart / API and WebSocket interruption | Browser reconnected automatically; same daemon process and anchor; position continued |
| Admin frontend workflow restart | Dashboard reconnected with fresh sync; daemon process/anchor unchanged |
| Playable preview reaching its real end | Local MP4 fixture played, emitted timeupdates and ended; zero station mutation attempts |

The first pass exposed two genuine issues, now fixed: the REST `{state: ...}`
envelope was initially rejected by admin status monitoring, and historical
`blocked` repair outcomes caused an asset-health response-schema error.
An absent validated status now displays unknown rather than falsely off-air.

The initial preview end-event check used blocked media and therefore **did not**
establish that a playable video completed. The targeted follow-up fulfilled media
range requests with a clearly labeled local MP4 fixture, without changing station
metadata or contacting production media. The video had readyState 4, played
unpaused for over 10 seconds with 39 timeupdates, then genuinely reached its end.
There were zero `/natural-end`, `/report-stall`, or `/report-position` attempts.

The follow-up authenticated asset-health response returned HTTP 200 with 70
items, without a schema-error toast. Dashboard and Master Control both matched
the daemon's ON AIR state; last-sync populated immediately and remained fresh.
Across API and frontend restarts, the same single daemon process and exact
anchor were observed while playback position advanced from 2141.529 to
2262.248 seconds. The daemon was not restarted for those two tests.

Expected test-induced errors included a deliberate unauthenticated 401 check,
offline requests, temporary 502/WebSocket failures during the API restart, and
the Vite connection closing during its restart. Some 404 resource requests
remain outside the proven media path; do not treat this run as an exhaustive
asset or route audit.

Sanitized detailed evidence is under `generated-artifacts/` (excluded from Git
and deployment). Fixture playback and runtime-clock evidence are not a
certificate of uninterrupted production media delivery.

## Outstanding production gates

- Confirm actual Render plans and apply reviewed Blueprint settings. The checked-in
  API plan is Free; no paid service change, deployment, or main push was performed.
- Uploaded media still shares the API delivery path. A healthy independent
  daemon does not make those bytes available while that API or its network is down.
- Validate real media, supported installed Android devices, realistic concurrent
  audience load, extended soak behavior, and production failover in an authorized
  staging environment. No destructive production fault injection was performed.
- Verify production database leadership and checkpoint recovery. Leadership
  loss must fail closed, and checkpointing is not a promise of zero data loss.
- Administrator presence is authenticated open connections on one API instance,
  not unique people or a global audience count.
- Development SMTP verification currently fails authentication; verify alert
  delivery separately using securely managed provider settings.
- Security scan certification, every route/permission combination, and complete
  production capacity are not established by this focused browser pass.

See `admin-broadcast-continuity-runbook.md` for ownership, hosting limitations,
release procedures, and incident-response guidance.
