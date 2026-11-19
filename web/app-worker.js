// Runs the app (web/build/security.mjs, compiled from src/ with web/wasm/shim.cpp) in this module
// Worker, so key generation and the 8192-bit RSA operations never block the page.
// In:  {type: 'start' | 'restart'} | {type: 'line', text} | {type: 'wake'} | {type: 'clock', addMs | reset}
// Out: {type: 'out', text} | {type: 'echo', on} | {type: 'thread', ms} | {type: 'busy', label}
//      | {type: 'clock', now, offset} | {type: 'exit', code} | {type: 'waiting'} | {type: 'error', message}
import createModule from './build/security.mjs';
import { createShell, CWD, HOME } from './shell.js';

// The virtual clock: the app's time(), localtime() and file times all come from Date.now().
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const postClock = () => postMessage({ type: 'clock', now: Date.now(), offset });

const decoder = new TextDecoder();
let outBytes = [];
const flush = () => {
  if (!outBytes.length) return;
  const text = decoder.decode(Uint8Array.from(outBytes), { stream: true });
  outBytes = [];
  if (text) postMessage({ type: 'out', text });
};
const write = (b) => { outBytes.push(b); if (outBytes.length > 8192) flush(); };

let input = [];     // queued stdin bytes
let waiter = null;  // the app waiting for input: {resolve, timer}
let pristine = null; // disk-model as setup.sh made it (web/build/disk-model.json)
let disk = null;     // disk-model carried over from the last run
let running = false;
let current = null;   // the running module instance

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function loadPristine() {
  const res = await fetch(new URL('./build/disk-model.json', import.meta.url));
  if (!res.ok) throw new Error(`disk-model.json: HTTP ${res.status}`);
  const { entries } = await res.json();
  return entries.map((e) => ({ ...e, data: e.data !== undefined ? b64(e.data) : undefined }));
}

function snapshot(FS) {
  const out = [];
  FS.ignorePermissions = true;
  const walk = (rel) => {
    const st = FS.stat(CWD + '/' + rel);
    const dir = FS.isDir(st.mode);
    out.push({ path: rel, dir, mode: st.mode & 0o7777, mtime: +st.mtime, data: dir ? undefined : FS.readFile(CWD + '/' + rel) });
    if (dir) for (const n of FS.readdir(CWD + '/' + rel)) if (n !== '.' && n !== '..') walk(rel + '/' + n);
  };
  try { walk('disk-model'); } finally { FS.ignorePermissions = false; }
  return out;
}

function restore(FS, entries) {
  FS.mkdirTree(CWD, 0o755);
  FS.chdir(CWD);
  FS.ignorePermissions = true;
  try {
    for (const e of entries) {
      const p = CWD + '/' + e.path;
      if (e.dir) FS.mkdir(p, 0o777); else FS.writeFile(p, e.data);
    }
    // modes and times last, deepest first, so the writes above weren't blocked
    for (const e of [...entries].reverse()) {
      const p = CWD + '/' + e.path;
      FS.chmod(p, e.mode);
      FS.utime(p, e.mtime, e.mtime);
    }
  } finally { FS.ignorePermissions = false; }
}

async function start() {
  if (running) return;
  running = true;
  input = [];
  pristine ??= await loadPristine();
  let M;
  const config = {
    stdin: () => (input.length ? input.shift() : null),
    stdout: write,
    stderr: write,
    noExitRuntime: false,
    onEcho: (on) => { flush(); postMessage({ type: 'echo', on }); },
    onThreadSleep: (ms) => { flush(); postMessage({ type: 'thread', ms }); },
    waitInput: (timeout) => {
      flush();
      if (input.length) return Promise.resolve(1);
      postMessage({ type: 'waiting' });
      return new Promise((resolve) => {
        waiter = { resolve, timer: timeout >= 0 ? setTimeout(() => { waiter = null; resolve(0); }, timeout) : null };
      });
    },
    onExit: (code) => finish(code),
  };
  const finish = (code) => {
    if (!running) return;
    flush();
    try { disk = snapshot(M.FS); } catch {}
    running = false;
    waiter = null;
    postMessage({ type: 'exit', code });
  };
  M = current = await createModule(config);
  M.shell = createShell(M.FS, {
    onBusy: (label) => { flush(); postMessage({ type: 'busy', label }); },
    print: (bytes) => { for (const b of bytes) write(b); },
  });
  M.FS.mkdirTree(HOME, 0o755);
  restore(M.FS, disk || pristine);
  postClock();
  try {
    M.callMain([]);
  } catch (e) {
    if (e?.name !== 'ExitStatus') postMessage({ type: 'error', message: String(e?.stack || e) });
  }
}

// exit() called after the app resumed from waiting for input ends that resumed call with ExitStatus.
const isExit = (e) => e?.name === 'ExitStatus' || /^ExitStatus/.test(String(e));
self.addEventListener('unhandledrejection', (ev) => { if (isExit(ev.reason)) ev.preventDefault(); });
self.addEventListener('error', (ev) => { if (isExit(ev.error) || /ExitStatus|Program terminated/.test(ev.message)) ev.preventDefault(); });

onmessage = ({ data }) => {
  switch (data.type) {
    case 'start':
      start().catch((e) => { running = false; postMessage({ type: 'error', message: String(e?.message || e) }); });
      break;
    case 'line':
      if (!running) return;
      input.push(...new TextEncoder().encode(data.text + '\n'));
      if (waiter) { const w = waiter; waiter = null; clearTimeout(w.timer); w.resolve(1); }
      break;
    case 'wake': // end the verification thread's sleep now
      if (waiter && waiter.timer !== null) { const w = waiter; waiter = null; clearTimeout(w.timer); w.resolve(0); }
      break;
    case 'clock':
      offset = data.reset ? 0 : offset + data.addMs;
      postClock();
      break;
    case 'restart': // stop the run (keeping its disk-model) and start the app again
      if (running && current) {
        try { disk = snapshot(current.FS); } catch {}
        if (waiter) clearTimeout(waiter.timer);
        waiter = null;
        running = false;
        current = null;
      }
      start().catch((e) => { running = false; postMessage({ type: 'error', message: String(e?.message || e) }); });
      break;
  }
};
