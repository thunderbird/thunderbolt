# Thunderbolt Backend

This repository contains the backend service for the Thunderbolt project. It is built using FastAPI and leverages the LiteLLM proxy to provide a unified interface for accessing various language models.

## Features

- Exposes LiteLLM proxy endpoints for language model interactions.
- Includes a simple health check endpoint.
- Uses Pydantic Settings for configuration management via environment variables and `.env` files.

## Prerequisites

- Python via [UV](https://docs.astral.sh/uv/)

## Setup

1.  Navigate to the `backend` directory:
    ```bash
    cd backend
    ```
2.  Install dependencies using `uv`:
    ```bash
    uv sync
    ```
3.  Create a `.env` file in the `backend` directory.

## ruyn

## Running the Application

1. Start the backend server:

   ```bash
   uv run fastapi dev
   ```

2. The server will start on `http://localhost:8000` by default.

3. The LiteLLM proxy endpoints are available at `/v1/chat/completions` and other standard OpenAI-compatible paths.
