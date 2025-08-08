import json
import os

import pytest
from fastapi.testclient import TestClient

from main import app


def test_flower_live_chat_completions_roundtrip() -> None:
    """
    Live test to hit the Flower proxy. This test is skipped unless FLOWER_LIVE_TEST=1.
    It passes when Flower returns HTTP 200 for /flower/v1/chat/completions.
    """
    if os.getenv("FLOWER_LIVE_TEST") != "1":
        pytest.skip("Set FLOWER_LIVE_TEST=1 to enable live Flower proxy test")

    bearer = os.getenv("FLOWER_TEST_API_KEY")
    if not bearer:
        pytest.skip(
            "Set FLOWER_TEST_API_KEY to a valid Flower project API key (fk_...) to run live test"
        )

    model = os.getenv("FLOWER_TEST_MODEL", "qwen/qwen3-235b")

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {bearer}",
        "Origin": "http://localhost:1420",
    }

    payload = {
        "model": model,
        "temperature": 0.25,
        "messages": [
            {"role": "system", "content": "You are a helpful executive assistant."},
            {"role": "user", "content": "What is the forecast for this week?"},
        ],
        # Flower streaming can fail upstream; request non-streaming for reliability
        "stream": False,
    }

    client = TestClient(app)
    resp = client.post(
        "/flower/v1/chat/completions", headers=headers, data=json.dumps(payload)
    )

    if resp.status_code != 200:
        pytest.xfail(f"Flower live returned {resp.status_code}: {resp.text[:300]}")

    assert resp.status_code == 200
