#!/usr/bin/env bash
# Smoke test: boot the built image, wait for it to answer, assert HTTP < 400.
# Env (set by the reusable workflow, override locally):
#   IMAGE              image to run               (default localbuild:ci)
#   PORT               container port to curl     (REQUIRED)
#   HEALTH_PATH        path expected < 400        (default /)
#   REQUIRE_JSON_FIELD if set, the HEALTH_PATH JSON body must contain this key
#                      with a non-empty value (no-op when unset). e.g. seerr
#                      sets commitTag — an empty value boots + returns 200 but
#                      loops the UI on a "reload" prompt, which a plain HTTP
#                      check misses.
set -euo pipefail

IMAGE="${IMAGE:-localbuild:ci}"
PORT="${PORT:?set PORT}"
HEALTH_PATH="${HEALTH_PATH:-/}"
REQUIRE_JSON_FIELD="${REQUIRE_JSON_FIELD:-commitTag}"
NAME="smoke-$$"

cleanup() {
  docker logs "$NAME" 2>&1 | tail -n 50 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "▶ running $IMAGE"
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:${PORT}" "$IMAGE" >/dev/null

echo "▶ waiting for http://127.0.0.1:${PORT}${HEALTH_PATH}"
for i in $(seq 1 60); do
  # container must still be up
  if ! docker ps --filter "name=$NAME" --filter status=running -q | grep -q .; then
    echo "✘ container exited early"; exit 1
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}${HEALTH_PATH}" || echo 000)
  if [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; then
    echo "✔ smoke ok (HTTP $code after ${i}s)"
    if [ -n "$REQUIRE_JSON_FIELD" ]; then
      body=$(curl -s "http://127.0.0.1:${PORT}${HEALTH_PATH}" || true)
      # match "<field>": "<non-empty>" (string) or "<field>": <non-empty> (other)
      if echo "$body" | grep -Eq "\"${REQUIRE_JSON_FIELD}\"[[:space:]]*:[[:space:]]*(\"[^\"]+\"|[^\",}[:space:]]+)"; then
        echo "✔ required field '${REQUIRE_JSON_FIELD}' present and non-empty"
      else
        echo "✘ required field '${REQUIRE_JSON_FIELD}' missing or empty in ${HEALTH_PATH}"
        echo "  body: ${body:0:200}"
        exit 1
      fi
    fi
    exit 0
  fi
  sleep 2
done

echo "✘ no healthy response within timeout (last code: ${code:-none})"
exit 1
