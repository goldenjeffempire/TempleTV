"""Prometheus metric definitions.

Two metrics, matching the standard RED-adjacent pattern (Rate, Errors,
Duration) that most Grafana dashboards and alerting rules for HTTP
services are already built to expect:

  - `http_requests_total`: a Counter, labeled by method/path/status —
    rate() and error-rate queries both derive from this alone.
  - `http_request_duration_seconds`: a Histogram, same labels minus
    status — latency percentiles (p50/p95/p99) come from this.

Labeled by the *route template* (e.g. `/v1/services/{slug}`), never the
raw request path — labeling by raw path would create a new time series
per distinct slug/UUID ever requested, which is the classic way to quietly
blow up a Prometheus server's memory with unbounded cardinality.
"""

from prometheus_client import Counter, Histogram

REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests.",
    labelnames=("method", "path_template", "status_code"),
)

REQUEST_DURATION_SECONDS = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds.",
    labelnames=("method", "path_template"),
)
