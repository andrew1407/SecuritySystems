#!/usr/bin/env bash
# Runs the repo's own setup.sh (8192-bit admin keypair, encrypted journal and monitoring log) in a scratch
# dir and packs the disk-model/ it makes into web/build/disk-model.json, which the page loads at startup.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p web/build
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp setup.sh "$tmp/"
(cd "$tmp" && bash setup.sh 2>&1 | grep -v '^[.+*]*$' || true)
python3 web/wasm/pack_disk.py "$tmp/disk-model" web/build/disk-model.json
