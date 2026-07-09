#!/usr/bin/env bash
set -euo pipefail
docker compose up --build -d
trap 'docker compose down' EXIT
echo "waiting for stack..."; sleep 15
before=$(curl -s localhost:7100/status | python3 -c 'import sys,json;print(json.load(sys.stdin)["snapshot"]["realPowerW"])')
echo "before dispatch realPowerW=$before"
curl -s -X POST localhost:7001/test/dercontrol -H 'Content-Type: application/json' -d '{"mRID":"DEMO","opModFixedW":-3000}' >/dev/null
sleep 15
after=$(curl -s localhost:7100/status | python3 -c 'import sys,json;print(json.load(sys.stdin)["snapshot"]["realPowerW"])')
echo "after dispatch realPowerW=$after"
python3 -c "import sys; sys.exit(0 if float('$after') < 0 else 1)" && echo "PASS: dispatch moved telemetry" || { echo "FAIL"; exit 1; }
