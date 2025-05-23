from fastapi import FastAPI
import os
from functools import lru_cache
from backend.config import Settings

from litellm.proxy.proxy_server import app as litellm_app

@lru_cache
def get_settings():
    return Settings()

app = FastAPI()

settings = get_settings()

app.mount("/v1", litellm_app)      # exposes /v1/chat/completions etc.

@app.get("/health")
async def health():
    return {"status": "ok"}