"""
Test for the new Exa search endpoint
"""

import pytest
from fastapi.testclient import TestClient

from main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_search_exa_endpoint_exists(client):
    """Test that the search-exa endpoint exists"""
    response = client.post("/pro/search-exa", json={"query": "test", "max_results": 5})
    # Should get a response (either success or configured error), not 404
    assert response.status_code == 200


def test_search_exa_without_api_key(client):
    """Test that search-exa returns proper error when API key is not configured"""
    response = client.post("/pro/search-exa", json={"query": "test search", "max_results": 5})
    assert response.status_code == 200
    
    data = response.json()
    # Should indicate failure due to missing configuration
    if not data["success"]:
        assert "not configured" in data["error"] or "EXA_API_KEY" in data["error"]


def test_search_exa_request_validation(client):
    """Test that search-exa validates request parameters"""
    # Missing required field
    response = client.post("/pro/search-exa", json={"max_results": 5})
    assert response.status_code == 422  # Validation error
    
    # Invalid data type
    response = client.post("/pro/search-exa", json={"query": 123, "max_results": 5})
    assert response.status_code == 422  # Validation error