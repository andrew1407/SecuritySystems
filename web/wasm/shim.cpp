// Web-only glue that lets the unchanged sources in src/ run in a browser Web Worker (built by build.sh,
// never by run.sh). It replaces the few OS services the app relies on:
//  - system() and popen()/pclose() run the command in the worker's small JS shell (web/shell.js),
//    which implements ls, cat, echo, chmod, openssl and the rest over emscripten's in-memory FS;
//  - tcgetattr()/tcsetattr() keep a termios so that turning ECHO off masks the page's input line;
//  - stdin waits for a line from the page (Asyncify), so std::cin blocks like on a terminal;
//  - exit() really ends the run (emscripten_force_exit), so the page can offer to start it again;
//  - pthread_create() starts the verification thread (std::thread) as an emscripten fiber. Its
//    this_thread::sleep_for() parks the fiber, and the main thread, while waiting for input,
//    switches to it once the sleep is over, so the challenge appears on time even when idle.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include <termios.h>
#include <pthread.h>
#include <map>
#include <emscripten.h>
#include <emscripten/fiber.h>

extern "C" {

EM_JS(int, js_system, (const char *cmd), { return Module.shell.system(UTF8ToString(cmd)); });

// Runs the command and returns a malloc'ed buffer with its output (*len bytes).
EM_JS(char *, js_capture, (const char *cmd, size_t *len), {
  const out = Module.shell.capture(UTF8ToString(cmd));
  const p = _malloc(out.length + 1);
  HEAPU8.set(out, p);
  HEAPU8[p + out.length] = 0;
  HEAPU32[len >> 2] = out.length;
  return p;
});

EM_JS(void, js_echo, (int on), { Module.onEcho(!!on); });
EM_JS(void, js_thread_sleep, (double ms), { Module.onThreadSleep(ms); });
// Resolves 1 once a line of input is queued, or 0 when timeoutMs (if >= 0) runs out first.
EM_ASYNC_JS(int, js_wait_input, (double timeoutMs), { return await Module.waitInput(timeoutMs); });

int system(const char *cmd) {
  if (!cmd) return 1;
  return js_system(cmd);
}

static std::map<FILE *, char *> pipes;

FILE *popen(const char *cmd, const char *) {
  size_t len = 0;
  char *buf = js_capture(cmd, &len);
  FILE *f = fmemopen(buf, len ? len : 1, "r");
  if (!len) fgetc(f);  // an empty output: read past the placeholder byte so feof() is set
  pipes[f] = buf;
  return f;
}

int pclose(FILE *f) {
  fclose(f);
  free(pipes[f]);
  pipes.erase(f);
  return 0;
}

static struct termios tio = { .c_iflag = ICRNL, .c_oflag = OPOST | ONLCR, .c_lflag = ECHO | ICANON | ISIG };

int tcgetattr(int, struct termios *t) {
  *t = tio;
  return 0;
}

int tcsetattr(int, int, const struct termios *t) {
  tio = *t;
  js_echo(tio.c_lflag & ECHO);
  return 0;
}

// The verification thread as a fiber.
static emscripten_fiber_t mainFiber, threadFiber;
static bool hasThread = false, inThread = false;
static double wakeAt = 0;  // emscripten_get_now() time when the thread's sleep ends
static void *(*threadFn)(void *);
static void *threadArg;
alignas(16) static char mainAsyncStack[1 << 20], threadAsyncStack[1 << 16], threadCStack[1 << 18];

static void threadEntry(void *) {
  threadFn(threadArg);
  hasThread = false;
  emscripten_fiber_swap(&threadFiber, &mainFiber);
}

static void runThread() {
  inThread = true;
  emscripten_fiber_swap(&mainFiber, &threadFiber);
  inThread = false;
}

int pthread_create(pthread_t *t, const pthread_attr_t *, void *(*fn)(void *), void *arg) {
  if (hasThread) return 11;  // EAGAIN: the app starts one thread
  threadFn = fn;
  threadArg = arg;
  hasThread = true;
  *t = (pthread_t)1;
  emscripten_fiber_init_from_current_context(&mainFiber, mainAsyncStack, sizeof mainAsyncStack);
  emscripten_fiber_init(&threadFiber, threadEntry, nullptr, threadCStack, sizeof threadCStack,
    threadAsyncStack, sizeof threadAsyncStack);
  runThread();  // runs until the thread's first sleep_for()
  return 0;
}

int pthread_detach(pthread_t) { return 0; }

int nanosleep(const struct timespec *req, struct timespec *rem) {
  double ms = req->tv_sec * 1000.0 + req->tv_nsec / 1e6;
  if (rem) rem->tv_sec = rem->tv_nsec = 0;
  if (!inThread) {
    emscripten_sleep((unsigned)ms);
    return 0;
  }
  wakeAt = emscripten_get_now() + ms;
  js_thread_sleep(ms);
  emscripten_fiber_swap(&threadFiber, &mainFiber);
  return 0;
}

// stdin: wait for the page (switching to the thread whenever its sleep is over), then read as usual.
size_t __real___stdio_read(FILE *, unsigned char *, size_t);

size_t __wrap___stdio_read(FILE *f, unsigned char *buf, size_t len) {
  if (f == stdin && !inThread) {
    while (!js_wait_input(hasThread ? fmax(0, wakeAt - emscripten_get_now()) : -1)) runThread();
  }
  return __real___stdio_read(f, buf, len);
}

// exit(): the pending stdin wait and the thread fiber count as async work that keeps the runtime
// alive, which would turn exit() into a silent halt; force a real exit so the page sees it.
void __real_exit(int);

void __wrap_exit(int code) {
  fflush(nullptr);
  emscripten_force_exit(code);
  __real_exit(code);
}

__attribute__((constructor)) static void unbufferedStdout() { setvbuf(stdout, nullptr, _IONBF, 0); }

}
