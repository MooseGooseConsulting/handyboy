# Handyboy. `just` lists every recipe.
# Live recipes act in your real Chrome, as you, with the free Nemotron pair.

set shell := ["bash", "-euo", "pipefail", "-c"]
set positional-arguments

default:
    @just --list

# Build, register the host, and connect the extension in your real Chrome. Safe to re-run.
setup:
    bash scripts/live.sh setup

# Run fixture tasks (comma-separated; default: every local one) in real Chrome and score each.
test-live tasks="":
    bash scripts/live.sh test "{{tasks}}"

# One ad-hoc run: just run "<prompt>" --url <url>
run *args:
    bash scripts/live.sh run "$@"

# Is the host up, is the extension connected, is the key valid?
status:
    bash scripts/live.sh status

# Errors the extension forwarded to the host.
logs:
    bash scripts/live.sh logs

# Typecheck and unit tests for the extension and the host, as CI runs them.
check:
    node_modules/.bin/tsc --noEmit
    node_modules/.bin/vitest run
    bash scripts/check-invariants.sh
    cd host && node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run

# The harness tiers in a harness-owned Chrome for Testing (see scripts/harness.sh).
harness *args:
    bash scripts/harness.sh "$@"
