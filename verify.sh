#!/usr/bin/env bash
set -e

# Target gateway URL (defaults to local port 3001)
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3001}"

# Seeded virtual test keys
RICH_KEY="${RICH_KEY:-rok_test_rich_1000000_abc123}"
EMPTY_KEY="${EMPTY_KEY:-rok_test_empty_0000000_ghi789}"

echo "=========================================================="
echo " 1. Health Check"
echo "=========================================================="
curl -s "${GATEWAY_URL}/health" | jq .

echo -e "\n=========================================================="
echo " 2. Normal LLM Proxy Call (Primary Provider: Groq)"
echo "=========================================================="
curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${RICH_KEY}" \
  -d '{
    "model": "qwen/qwen3.8-27b",
    "messages": [{"role": "user", "content": "Reply with exactly: Gateway operational."}],
    "max_tokens": 32
  }' | jq '{id, model, content: .choices[0].message.content, usage, x_gateway}'

echo -e "\n=========================================================="
echo " 3. Resilient Fallback Test (Simulated Primary 503 -> Gemini)"
echo "=========================================================="
curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${RICH_KEY}" \
  -H "x-simulate-primary-failure: true" \
  -d '{
    "model": "qwen/qwen3.8-27b",
    "messages": [{"role": "user", "content": "Reply with exactly: Fallback operational."}],
    "max_tokens": 32
  }' | jq '{id, model, content: .choices[0].message.content, usage, x_gateway}'

echo -e "\n=========================================================="
echo " 4. Per-Key Budget Enforcement (Exhausted Key -> HTTP 402)"
echo "=========================================================="
curl -s -i -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${EMPTY_KEY}" \
  -d '{
    "model": "qwen/qwen3.8-27b",
    "messages": [{"role": "user", "content": "Should be blocked by budget check."}],
    "max_tokens": 32
  }' | head -n 20

echo -e "\n=========================================================="
echo " 5. Usage & Spend Telemetry Check (GET /v1/usage)"
echo "=========================================================="
curl -s "${GATEWAY_URL}/v1/usage?key=${RICH_KEY}" | jq .
