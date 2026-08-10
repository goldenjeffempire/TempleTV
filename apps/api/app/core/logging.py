"""Structured logging configuration.

Emits JSON logs so they can be shipped to Loki/Promtail without any
reformatting. Every log line carries the standard fields (timestamp, level,
logger name, message) plus room for request-scoped context (request_id).
"""

import logging
import sys

from pythonjsonlogger import jsonlogger

from app.config import get_settings


def configure_logging() -> None:
    """Configure the root logger for structured JSON output.

    Idempotent: safe to call multiple times (e.g. once at import time and
    once explicitly in `main.py`'s lifespan) without duplicating handlers.
    """
    settings = get_settings()
    root_logger = logging.getLogger()

    # Avoid attaching duplicate handlers on reload / repeated calls.
    if any(isinstance(h, logging.StreamHandler) for h in root_logger.handlers):
        root_logger.setLevel(settings.log_level)
        return

    handler = logging.StreamHandler(sys.stdout)
    formatter = jsonlogger.JsonFormatter(
        fmt="%(asctime)s %(name)s %(levelname)s %(message)s",
        rename_fields={"asctime": "timestamp", "levelname": "level", "name": "logger"},
    )
    handler.setFormatter(formatter)

    root_logger.handlers = [handler]
    root_logger.setLevel(settings.log_level)

    # Quiet noisy third-party loggers unless we're debugging.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """Return a module-scoped logger. Prefer this over `logging.getLogger` directly."""
    return logging.getLogger(name)
