"""Aggregates all v1 routers into a single APIRouter mounted by `main.py`."""

from fastapi import APIRouter

from app.api.v1 import agencies, api_keys, auth, health, knowledge, query, search, services, version

api_v1_router = APIRouter()
api_v1_router.include_router(health.router)
api_v1_router.include_router(version.router)
api_v1_router.include_router(knowledge.router)
api_v1_router.include_router(agencies.router)
api_v1_router.include_router(services.router)
api_v1_router.include_router(query.router)
api_v1_router.include_router(search.router)
api_v1_router.include_router(auth.router)
api_v1_router.include_router(api_keys.router)
