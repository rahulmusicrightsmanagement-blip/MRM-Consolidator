"""Where a request's time goes: database, Google Drive, report processing.

Every response gets a Server-Timing header (browser DevTools → Network → the request → Timing), and API requests
slower than MRM_SLOW_REQUEST_SECONDS (default 0.5) are logged, e.g.
    GET /api/clients/ 200 in 6.20s: db 1.10s (32 queries), drive 3.90s (3 calls), processing 0.80s (1 report), rest 0.40s
"""
import logging
import os
import threading
import time
from contextlib import contextmanager

from django.db import connection

logger = logging.getLogger(__name__)
SLOW = float(os.environ.get("MRM_SLOW_REQUEST_SECONDS", "0.5"))
BUCKETS = (("db", "queries", "query"), ("drive", "calls", "call"), ("processing", "reports", "report"))
_local = threading.local()


@contextmanager
def measure(bucket):
    """Add the time spent inside the block to this request's bucket (no-op outside a request, e.g. a background upload)."""
    stats = getattr(_local, "stats", None)
    start = time.perf_counter()
    try:
        yield
    finally:
        if stats is not None:
            stats[bucket][0] += time.perf_counter() - start
            stats[bucket][1] += 1


def _db(execute, sql, params, many, context):
    with measure("db"):
        return execute(sql, params, many, context)


class TimingMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        _local.stats = {name: [0.0, 0] for name, _, _ in BUCKETS}
        start = time.perf_counter()
        try:
            with connection.execute_wrapper(_db):
                response = self.get_response(request)
            total = time.perf_counter() - start
            stats = _local.stats
        finally:
            _local.stats = None
        parts = [f"{name};dur={stats[name][0] * 1000:.0f};desc=\"{stats[name][1]} {many}\"" for name, many, _ in BUCKETS]
        response["Server-Timing"] = ", ".join(parts + [f"total;dur={total * 1000:.0f}"])
        if request.path.startswith("/api/") and total >= SLOW:
            spent = sum(stats[name][0] for name in ("db", "drive", "processing"))
            detail = ", ".join(f"{name} {stats[name][0]:.2f}s ({stats[name][1]} {one if stats[name][1] == 1 else many})"
                               for name, many, one in BUCKETS)
            logger.info("%s %s %s in %.2fs: %s, rest %.2fs", request.method, request.path, response.status_code, total,
                        detail, max(total - spent, 0))
        return response
