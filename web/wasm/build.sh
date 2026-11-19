#!/usr/bin/env bash
# Compile the app (src/ + lib/mathexpr) with the web shim to web/build/security.mjs + .wasm (needs emsdk: source emsdk_env.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p web/build
# -D_GNU_SOURCE + sys/types.h give the glibc `uint` typedef the sources use; --wrap routes stdin reads and exit() through the shim.
em++ -O2 -std=c++20 -D_GNU_SOURCE -include sys/types.h -fexceptions -Wno-c99-designator -Wno-vla-cxx-extension \
  lib/mathexpr/mathexpr.cpp $(find src -name '*.cpp' | sort) web/wasm/shim.cpp \
  -sASYNCIFY -sASYNCIFY_STACK_SIZE=1048576 -sSTACK_SIZE=1MB -sALLOW_MEMORY_GROWTH \
  -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=worker -sINVOKE_RUN=0 -sEXIT_RUNTIME \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sFORCE_FILESYSTEM -Wl,--wrap=__stdio_read,--wrap=exit \
  -o web/build/security.mjs
ls -la web/build
