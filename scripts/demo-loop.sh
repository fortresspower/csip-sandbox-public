#!/usr/bin/env bash
# Compatibility wrapper for `npm run demo`.
#
# The demo now lives in the toolkit CLI, which does the same thing with polling instead of
# fixed sleeps and tears the stack down on every exit path including Ctrl-C. This script stays
# so that documentation, muscle memory, and any existing automation calling it keep working.
#
# Equivalent: npx fortress-csip demo --verify
set -euo pipefail
exec node "$(dirname "$0")/../packages/cli/bin/fortress-csip.mjs" demo --verify "$@"
