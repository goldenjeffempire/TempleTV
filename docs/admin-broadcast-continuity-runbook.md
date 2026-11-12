# Admin and broadcast continuity

## Ownership and allowed effects

The V2 broadcast daemon owns the station clock, queue transitions, checkpointing,
and recovery. The admin SPA observes that runtime and submits explicitly
authorized operator commands. Closing a tab, logging out, refreshing, losing the
admin network connection, or detaching a preview must never be a stop command.
Observer and audience player sessions are isolated even when they use the same
station URL. Observer sessions cannot send natural-end or stall telemetry.

The legacy V1 compatibility engine and guide still exist. They are not evidence
of V2 daemon leadership. Check the daemon's V2 health and readiness, not the
legacy API engine's started flag, when diagnosing the authoritative broadcast.

## Operator-facing meanings

- **Dashboard connection** describes this console's event transport, not media.
- **Admin consoles** counts authenticated open admin event connections on the
  current API instance. Two tabs are two consoles; it is not a count of unique
  people, audience devices, or operators across all replicas.
- **Last live sync** is the browser's receipt time of the last validated
  authoritative broadcast-status frame, not merely an open TCP connection.
- Runtime status that cannot be read is unknown, never a fabricated OFF AIR.
- A running engine describes sequencing. Successful media delivery additionally
  requires the uploaded object, API/delivery origin, network, and player.

Admin event heartbeats run every five seconds. Status reads are coalesced and
cached across consoles, including short failure caching. Reconnection uses the
existing bounded exponential backoff/jitter and refreshes query data. Abrupt
disconnect detection remains bounded by TCP failure detection and the existing
event-stream zombie watchdog, rather than pretending disconnects are instant.

## Deployments

`render.yaml` separates API and daemon services. UI-only commits no longer
automatically redeploy the daemon. Shared server/build changes intentionally
remain in its deployment filter: deploy compatible versions and verify them.
The filter takes effect only after the Render Blueprint configuration is synced.

No paid service change or production deployment is performed by this upgrade.
Repository plans do not establish the current plans in the operator's account.
The configured API is Free, and the private daemon uses Starter.

Render's official Free-instance documentation states that Free web services
can spin down after 15 minutes without inbound traffic and take about one
minute to start again. Free instances also have usage/resource limits and are
not recommended for production applications:
https://render.com/docs/free

For a 24/7 station, review an always-on API plan and capacity before releasing.
That introduces recurring hosting cost and requires the owner's approval.
Keepalive traffic is not a substitute for a suitable hosting plan.

## Remaining infrastructure boundaries

1. **Uploaded media shares the API.** An API process outage can interrupt fresh
   byte-range/media requests even while the daemon's clock continues. Separating
   delivery requires a deliberately configured and tested independent public
   origin/CDN and any associated hosting/egress costs. It is not solved by a
   status badge, a retry loop, or the daemon's private health socket.
2. **Leadership requires fencing.** The pinned transaction-scoped database lock
   prevents duplicate V2 leaders. Losing that leadership connection intentionally
   stops the daemon; weakening this protection would risk split-brain operation.
   Ordinary background-query failures are distinct from losing leadership.
3. **Durability is not zero loss.** Normal checkpoints and the shutdown flush
   support recovery. SIGKILL/power loss can lose the most recent uncommitted
   progress. Measure real recovery and player behavior; do not promise a zero
   recovery time or 100% uptime.
4. **Replica scope is explicit.** Console presence is API-instance-local.
   Globally unique operator presence would require authenticated identity leases
   in a shared store, not counting event-bus listeners.
5. **Production certification is separate.** Confirm actual instance plans,
   memory/DB capacity, production source accessibility, CORS, range requests,
   audience reconnection, installed Android playback, and a controlled staging
   soak before declaring the complete station production-certified.

## Safe fault-test procedure

Never use production endpoints or production process controls for these tests.
Use a development database and independently observe the private daemon.

1. Record daemon process identity/readiness, queue sequence, current item,
   start/end timestamps, and position before opening the console.
2. Log into the real admin UI. Open a second console, observe presence, and
   close it. Trigger local preview-ended events and verify that no playback
   mutation request is emitted.
3. Disconnect only the admin browser, reconnect, refresh, log out, close the
   tab, and reopen it. Check dashboard recovery and daemon-clock continuity.
4. Restart only the frontend and then only the API. Verify the daemon does not
   restart, distinguish any shared-media interruption, and verify status recovery.
5. In development, kill the daemon process, restart it, and compare persisted
   session/queue state and playback position. Verify there is only one leader.
6. Do not call state progression proof of uninterrupted media playback. Report
   untested cases, unavailable sources, actual failures, and native-device gates.
