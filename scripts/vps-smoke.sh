#!/bin/bash
# VPS smoke for FIX-R.3: confirm the search-queries.json file in the running worker
# image parses cleanly, and check the current tavilyCycleN state on the two orchestrators.
set -e
ssh -p 49108 -o BatchMode=yes root@10.66.66.1 bash <<'REMOTE'
echo "=== worker file parses ==="
docker exec aihot-worker-1 node -e 'JSON.parse(require("fs").readFileSync("industry/search-queries.json","utf8")); console.log("WORKER_FILE_OK")'
echo ""
echo "=== tavily cycle counters ==="
docker exec aihot-db psql -U aihot -d aihot -c "SELECT id, cursor->>'tavilyCycleN' AS tavilycyclen FROM sources WHERE id IN ('search-api-virtual','prompts-api-virtual') ORDER BY id;"
REMOTE