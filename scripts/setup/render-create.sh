#!/usr/bin/env bash
# Create (or update) the student's Render web service. See render.js for the env inputs.
. "$(dirname "$0")/common.sh"
need_env RENDER_API_KEY DATABASE_URL REPO_URL
exec node "$KIT_ROOT/scripts/setup/render.js" create
