# Health Check Endpoints

This document describes the health check endpoints for monitoring AI service availability and response quality.

## Overview

The health check endpoints provide real-time monitoring of AI services by making 
actual API calls and validating responses. They're designed for use with external 
monitoring services like Betterstack, Pingdom, or custom monitoring systems.

## Configuration

### Environment Variables

Add the following to your `.env` file:

```bash
# Health Check Configuration
MONITORING_TOKEN=your_secret_monitoring_token_here
```

The monitoring token acts as a simple authentication mechanism to prevent 
unauthorized access to health check endpoints.

### Supported Models

Currently configured models:

- `qwen/qwen3-235b`: Flower AI Qwen3 model with streaming validation

The health check system supports any model name with a default configuration. 
You can specify any model name that's available in your Flower AI project. If you 
need custom settings for specific models, you can add them to the 
`HEALTH_CHECK_CONFIGS` in `healthcheck.py`.

## Endpoints

### GET /healthcheck/flower/{model}

Performs a health check on a specific Flower AI model using streaming 
validation.

**Parameters:**
- `model`: Any model name available in your Flower AI project 
  (e.g., "qwen/qwen3-235b")
- `token`: Monitoring token (query parameter)

**Example Request:**
```bash
curl "https://your-api.com/healthcheck/flower/qwen/qwen3-235b?token=your_monitoring_token"
```

**Note:** Model names containing slashes (like `qwen/qwen3-235b`) are supported. 
If you're unsure what models are available, check your 
[Flower AI project dashboard](https://flower.ai) or contact your administrator.

**Success Response (200):**
```json
{
  "ok": true,
  "model": "qwen/qwen3-235b",
  "service": "flower",
  "latency_ms": 245.67,
  "timestamp": "2024-01-15T10:30:00.123Z",
  "response": "Healthcheck confirmed.",
  "error": null
}
```

**Error Response (503) - Response Mismatch:**
```json
{
  "ok": false,
  "model": "qwen/qwen3-235b",
  "service": "flower",
  "latency_ms": 1250.45,
  "timestamp": "2024-01-15T10:30:00.123Z",
  "response": "Wrong response",
  "error": "Response mismatch: expected 'Healthcheck confirmed.' but got 'Wrong response'"
}
```

**Error Response (503) - Model Not Available:**
```json
{
  "ok": false,
  "model": "invalid-model",
  "service": "flower",
  "latency_ms": 1204.66,
  "timestamp": "2024-01-15T10:30:00.123Z",
  "response": "",
  "error": "Model 'invalid-model' is not available in your Flower AI project. Please check your project configuration or use a different model name."
}
```

### GET /healthcheck/status

Returns the status of all configured health check endpoints.

**Parameters:**
- `token`: Monitoring token (query parameter)

**Example Request:**
```bash
curl "https://your-api.com/healthcheck/status?token=your_monitoring_token"
```

**Response (200):**
```json
{
  "timestamp": "2024-01-15T10:30:00.123Z",
  "services": {
    "flower": {
        "available": true,
        "models": ["qwen/qwen3-235b"]
    }
  },
  "total_endpoints": 1
}
```

## How It Works

1. **Streaming Validation**: The health check makes a real streaming request to 
   the AI service
2. **Response Validation**: Collects the full streamed response and validates it 
   matches exactly what we expect
3. **Latency Tracking**: Measures end-to-end response time including streaming
4. **Error Handling**: Captures and reports various failure modes (timeouts, 
   HTTP errors, response mismatches)

## Error Codes

- `401`: Invalid or missing monitoring token
- `503`: Service unavailable (configuration issues, timeouts, or validation failures)
- `422`: Missing required parameters

## Monitoring Service Integration

### Betterstack/Pingdom

Configure your monitoring service to:

1. Make GET requests to the health check endpoints
2. Include the monitoring token as a query parameter
3. Expect 200 status code for healthy services
4. Set appropriate timeout values (recommend 30 seconds)
5. Check for `"ok": true` in the JSON response

Example monitoring URL:
```
https://your-api.com/healthcheck/flower/qwen/qwen3-235b?token=your_monitoring_token
```

### Custom Monitoring

The JSON response format is designed to be easily parsed by monitoring systems:

- `ok`: Boolean indicating overall health
- `latency_ms`: Response time for SLA monitoring
- `error`: Human-readable error description
- `timestamp`: When the check was performed

## Security

- The monitoring token should be kept secret and only shared with monitoring services
- Health check endpoints are rate-limited through the same mechanisms as other API endpoints
- No sensitive data is exposed in error responses

## Model Configuration

### Finding Available Models

To find what models are available in your Flower AI project:

1. Check your [Flower AI project dashboard](https://flower.ai)
2. Contact your Flower AI administrator
3. Try making a test request with a known working model name

### Adding Custom Model Configurations

By default, all models use the same health check configuration. To add custom 
settings for specific models, update the `HEALTH_CHECK_CONFIGS` dictionary in 
`healthcheck.py`:

```python
HEALTH_CHECK_CONFIGS = {
    "qwen/qwen3-235b": {
        "prompt": 'Hello, this is a healthcheck, please respond with the exact string "Healthcheck confirmed."',
        "expected_response": "Healthcheck confirmed.",
        "timeout": 15.0,
    },
    "your-other-model": {
        "prompt": "Custom health check prompt here",
        "expected_response": "Custom expected response",
        "timeout": 10.0,
    },
    # Add more models as needed
}
```

Models not listed in `HEALTH_CHECK_CONFIGS` will use the default configuration.

## Troubleshooting

### Common Issues

1. **503 "Health check not configured"**: `MONITORING_TOKEN` environment variable 
   not set
2. **401 "Invalid monitoring token"**: Incorrect token in query parameter
3. **503 "Flower AI not configured"**: Missing `FLOWER_MGMT_KEY` or `FLOWER_PROJ_ID`
4. **503 "Model 'X' is not available"**: The specified model is not available in 
   your Flower AI project
5. **503 "Request timeout"**: AI service taking longer than configured timeout
6. **503 "Response mismatch"**: AI service returning unexpected content

### Debugging

Enable debug logging to see detailed health check execution:

```bash
LOG_LEVEL=DEBUG
```

This will log the full request/response cycle for troubleshooting.