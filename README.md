# Security systems

<p align="center">
  <a href="https://andrew1407.github.io/SecuritySystems/" title="Open the app in the browser">
    <img src="web/icon.svg" alt="Security Systems" width="140" height="140">
  </a>
</p>

[![pages deploy badge](https://github.com/andrew1407/SecuritySystems/actions/workflows/pages.yml/badge.svg)](https://andrew1407.github.io/SecuritySystems/)

A single C++ console application modelling a **secured access-control system** over a simulated encrypted disk. It combines a layered login/registration state machine, POSIX file-permission gating per user role, RSA-encrypted journals and monitoring logs (via OpenSSL), an FFT-based big-number arithmetic playground, and a periodic identity-verification challenge running on a background thread. The "disk" is a real directory tree (`disk-model/`) whose `.admin` area holds the RSA keypair and the encrypted journal and monitoring log.

## How it works

Execution starts in [`src/main.cpp`](src/main.cpp), which instantiates [`AccessController`](src/accessController/AccessController.cpp) and calls `login()`. The controller walks a chain of UI **layers** (each implementing the [`Layer`](src/accessController/layers/Layer.hpp) interface with `run()` / `next()`), transitioning from one screen to the next until the user reaches the interactive shell. Once the shell ([`InputMode`](src/accessController/layers/inputMode/InputMode.cpp)) is active, a detached thread periodically poses a secret-question or a hidden-function verification challenge; a wrong or missing answer reduces the user's remaining tries and can wipe the account.

Sensitive data (the journal of users and the monitoring log) is never stored in plaintext: it is decrypted with the admin private key only while being read, and re-encrypted with the public key after every write. Directory access is constrained at the OS level via `chmod`, with the active permission bits chosen by the caller's [`Privilege`](src/tools.hpp) (admin / privileged / common user).

## Components

| Component | Description |
|---|---|
| [`src/main.cpp`](src/main.cpp) | Entry point — creates the `AccessController` and starts the login flow. |
| [`src/accessController/AccessController.cpp`](src/accessController/AccessController.cpp) | Drives the layer state machine and spawns the background verification thread for the input shell. |
| [`src/accessController/layers/Layer.hpp`](src/accessController/layers/Layer.hpp) | Abstract base interface (`run()` / `next()`) shared by every screen. |
| [`src/accessController/layers/signOption`](src/accessController/layers/signOption) | First screen — choose to sign up or sign in, enforcing the `MAX_USERS` limit. |
| [`src/accessController/layers/registrationForm`](src/accessController/layers/registrationForm) | Registration flow: pick a [`userType`](src/accessController/layers/registrationForm/userType), enter a [`nameInputReg`](src/accessController/layers/registrationForm/nameInputReg) and [`passwordInputReg`](src/accessController/layers/registrationForm/passwordInputReg), then set security questions in [`questionAsk`](src/accessController/layers/registrationForm/questionAsk) (which also generates the user's RSA keys). |
| [`src/accessController/layers/loginForm`](src/accessController/layers/loginForm) | Login flow: [`nameInputLog`](src/accessController/layers/loginForm/nameInputLog), [`passwordInputLog`](src/accessController/layers/loginForm/passwordInputLog), forced [`passwordReset`](src/accessController/layers/loginForm/passwordReset) when the password period expires, and [`keysRefreshSubmission`](src/accessController/layers/loginForm/keysRefreshSubmission) when the RSA keys expire. |
| [`src/accessController/layers/diskReader`](src/accessController/layers/diskReader) | Lists the disk entries and applies per-privilege `chmod` access (admins see everything, common users only `ALLOWED_FOLDERS`, nobody but admin sees `.admin`). |
| [`src/accessController/layers/inputMode`](src/accessController/layers/inputMode) | The interactive shell: runs system commands, dispatches `fft*` / `generatePrime()` / `encrypt` / `decrypt` commands, handles periodic verification challenges, logs exceptions, and triggers user-behavior monitoring. |
| [`src/accessController/input`](src/accessController/input) | Username/password prompts, including terminal echo-off hidden input and regex strength rules. |
| [`src/crypto`](src/crypto) | Cryptography namespace: RSA key-gen/encrypt/decrypt via OpenSSL ([`rsa.cpp`](src/crypto/rsa.cpp)), OpenSSL prime generation ([`primes.cpp`](src/crypto/primes.cpp)), and FFT-based add/multiply/power on big integers ([`cryptofft.cpp`](src/crypto/cryptofft.cpp), [`fft.cpp`](src/crypto/fft.cpp)). |
| [`src/dataparser`](src/dataparser) | Reads/writes the encrypted [`user`](src/dataparser/user.cpp) journal and [`monitoring`](src/dataparser/monitoring.cpp) log, extracts the secret [`mathExpression`](src/dataparser/mathExpression.cpp), and defines [`ParsingException`](src/dataparser/ParsingException.cpp). |
| [`src/cmd`](src/cmd) | Shell helpers: `chmod` wrapper, run-with-permission-rules, captured command output, and command-type detection. |
| [`src/functionCheck`](src/functionCheck) | Generates a random `x` and evaluates the secret journal expression `f(x)` to verify the user. |
| [`src/logger`](src/logger) | Current-time formatting and expiry checks ([`timeManager.cpp`](src/logger/timeManager.cpp)). |
| [`src/tools.hpp`](src/tools.hpp) | Central constants — disk paths, key sizes, limits, and the `Privilege` / `Modifiers` enums. |
| [`lib/mathexpr`](lib/mathexpr) | Third-party math-expression parser/evaluator (`mathexpr` by Yann Ollivier) used to evaluate the secret function. |

## Showcase

**[Open the app in the browser](https://andrew1407.github.io/SecuritySystems/)**. The console app runs in an in-page terminal (it works with a phone keyboard too): sign up as an admin, privileged or common user, sign in, use the shell and the `fft*`, `generatePrime()`, `encrypt` and `decrypt` commands, and answer the verification challenges. The terminal output can be copied.

- **The C++ is the real one.** All of `src/` and `lib/mathexpr` is compiled to WebAssembly with emscripten by [`web/wasm/build.sh`](web/wasm/build.sh) and runs in a Web Worker, so the page never freezes. The only addition is [`web/wasm/shim.cpp`](web/wasm/shim.cpp), which provides the OS services below; `std::cin` blocks on the terminal through Asyncify, and turning echo off with `termios` masks the input.
- **Disk.** The `disk-model/` comes from the real [`setup.sh`](setup.sh), run at build time by [`web/wasm/disk.sh`](web/wasm/disk.sh): the 8192-bit admin keypair and the journal and monitoring log encrypted by OpenSSL. It lives in emscripten's in-memory FS, which enforces the `chmod` bits, so each role really sees different access. It's kept between runs in the tab.
- **`system()` and `popen()`** run a small JS shell ([`web/shell.js`](web/shell.js)) with `ls`, `cat`, `echo`, `mkdir`, `rm`, `chmod`, `openssl` and a few more. `openssl genrsa`, `rsa`, `pkeyutl` and `prime` are BigInt code ([`web/rsa.js`](web/rsa.js)) with OpenSSL's PKCS#1 v1.5 padding. 8192-bit key generation would take too long in a browser, so keys made at sign-up or refresh are 2048-bit.
- **The verification thread.** GitHub Pages can't send the COOP/COEP headers that wasm threads need, so `pthread_create` (behind `std::thread`) starts `AccessController::questionsSending` as an emscripten fiber. Its `sleep_for` parks the fiber, and while the app waits for input it switches to the fiber once the minute is over, so challenges arrive on time, as with the native thread. An "Ask now" button ends the wait early.
- **Time.** A virtual clock (+1 / +3 / +4 days) moves the app's `time()`, to show the forced password reset, the key refresh and the daily monitoring.

Run it locally (needs [emsdk](https://emscripten.org/docs/getting_started/downloads.html) and OpenSSL):

```sh
./web/wasm/build.sh   # builds web/build/security.mjs + .wasm
./web/wasm/disk.sh    # runs setup.sh and packs web/build/disk-model.json
mkdir -p _site/web && cp web/*.html web/*.js web/*.svg _site/web/ && cp -r web/build _site/web/
python3 -m http.server 8000 --directory _site   # open http://localhost:8000/web/
```

## Stack

- **C++** (compiled with `g++`, `-pthread`; uses `<thread>`, `<filesystem>`, `<complex>`, POSIX `termios`).
- **OpenSSL** CLI (`openssl genrsa`, `rsa`, `rsautl`, `prime`) for RSA keypairs, encryption/decryption, and prime generation.
- POSIX `chmod` for role-based access enforcement over the `disk-model/` directory tree.
- [`lib/mathexpr`](lib/mathexpr) for runtime evaluation of mathematical expressions.

## Build & Run

First create the simulated disk model. This builds the `disk-model/` tree (folders `A`–`E` plus a hidden `.admin`), generates the 8192-bit RSA keypair, and writes the secret-function journal and monitoring log encrypted with the public key:

**Make disk model:**

```bash
./setup
```

Then compile all sources and launch the application:

**Run & build script:**

```bash
./run
```

## Project structure

```
SecuritySystems/
├── setup.sh                # builds disk-model/ + RSA keys + encrypted journal/log
├── run.sh                  # compiles all sources to out/lab and runs it
├── web/                    # browser showcase: terminal page, JS shell + openssl, wasm shim and build
├── lib/
│   └── mathexpr/           # third-party math expression evaluator
└── src/
    ├── main.cpp            # entry point
    ├── tools.hpp           # constants, Privilege & Modifiers enums
    ├── accessController/   # layered login/registration state machine
    ├── cmd/                # shell / chmod / command-detection helpers
    ├── crypto/             # RSA, prime generation, FFT arithmetic
    ├── dataparser/         # encrypted journal & monitoring parsing
    ├── functionCheck/      # secret-function verification
    └── logger/             # time formatting & expiry checks
```
