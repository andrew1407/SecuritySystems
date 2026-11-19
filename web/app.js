// The page: a terminal for the app running in web/app-worker.js, plus the clock and thread controls.
const $ = (id) => document.getElementById(id);
const term = $('term'), out = $('out'), lineEl = $('line'), caret = $('caret'), input = $('input');

const CHIPS = [
  ['Shell', ['ls -la disk-model', 'ls disk-model/.admin', 'cat disk-model/.admin/journal.txt', 'echo top secret > disk-model/A/note.txt', 'cat disk-model/A/note.txt', 'help']],
  ['App', ['fftMul(123456789, 987)', 'fftPow(2, 10)', 'fftAdd(999, 1)', 'generatePrime()',
    'encrypt disk-model/A/note.txt disk-model/A/note.enc', 'cat disk-model/A/note.enc', 'decrypt disk-model/A/note.enc disk-model/A/note.dec', 'cat disk-model/A/note.dec']],
];

let worker = null;
let echoOn = true;
let exited = false;
let threadAt = null; // performance.now() when the verification thread wakes
const history = [];
let histPos = 0;

// --- output ---
const MAX_CHARS = 200000;
function append(text, cls) {
  const nearBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 60;
  // the app's `clear` prints ESC[H ESC[2J ESC[3J; other escape sequences are dropped
  const parts = text.split(/\x1b\[(?:H\x1b\[)?2J(?:\x1b\[3J)?/);
  parts.forEach((p, i) => {
    if (i > 0) out.textContent = '';
    p = p.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '');
    if (!p) return;
    if (cls) { const s = document.createElement('span'); s.className = cls; s.textContent = p; out.append(s); }
    else if (out.lastChild?.nodeType === 3) out.lastChild.appendData(p);
    else out.append(p);
  });
  if (out.textContent.length > MAX_CHARS) {
    while (out.firstChild && out.textContent.length > MAX_CHARS * 0.8) out.firstChild.remove();
  }
  if (nearBottom || cls) term.scrollTop = term.scrollHeight;
}

function renderLine() {
  const v = input.value;
  const shown = echoOn ? v : '•'.repeat(v.length);
  const pos = input.selectionStart ?? v.length;
  lineEl.textContent = shown.slice(0, pos);
  caret.classList.toggle('mid', pos < v.length);
  caret.nextSibling?.remove?.();
  if (pos < v.length) caret.after(document.createTextNode(shown.slice(pos)));
}

function setStatus(kind, text) {
  const s = $('status');
  s.className = 'pill ' + kind;
  s.lastElementChild.textContent = text;
}

function setBusy(label) {
  $('busy').hidden = !label;
  if (label) $('busy').lastElementChild.textContent = label;
  if (label) setStatus('busy', 'working'); else if (!exited) setStatus('run', 'running');
}

// --- worker ---
function startWorker() {
  worker?.terminate();
  worker = new Worker(new URL('./app-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onMessage;
  worker.onerror = (e) => showError(e.message || 'The worker failed to start');
  run();
}

function run() {
  exited = false;
  threadAt = null;
  echoOn = true;
  $('echo').hidden = true;
  setStatus('busy', 'starting');
  worker.postMessage({ type: 'start' });
  updateThread();
}

function showError(msg) {
  const e = $('error');
  e.hidden = false;
  e.textContent = msg;
  setStatus('exit', 'error');
}

function onMessage({ data }) {
  switch (data.type) {
    case 'out': append(data.text); break;
    case 'waiting': setBusy(null); if (!exited) setStatus('run', 'waiting for input'); break;
    case 'echo':
      echoOn = data.on;
      $('echo').hidden = echoOn;
      input.type = echoOn ? 'text' : 'password';
      renderLine();
      break;
    case 'busy': setBusy(data.label); break;
    case 'thread': threadAt = performance.now() + data.ms; updateThread(); break;
    case 'clock': clockOffset = data.offset; updateClock(); break;
    case 'exit':
      exited = true;
      threadAt = null;
      setBusy(null);
      setStatus('exit', `exited (${data.code})`);
      append(`\n[The app exited with status ${data.code}. Press Enter or "Run again" to start it again; the disk-model keeps its state.]\n`, 'sys');
      echoOn = true;
      $('echo').hidden = true;
      input.type = 'text';
      updateThread();
      break;
    case 'error': showError(data.message); break;
  }
}

// --- input ---
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  send(input.value);
});

function send(text) {
  if (exited) { input.value = ''; renderLine(); run(); return; }
  append((echoOn ? text : '') + (echoOn ? '\n' : ''), 'typed');
  if (echoOn && text.trim()) { history.push(text); }
  histPos = history.length;
  worker.postMessage({ type: 'line', text });
  input.value = '';
  renderLine();
  setStatus('busy', 'running');
}

input.addEventListener('input', renderLine);
input.addEventListener('keyup', renderLine);
input.addEventListener('select', renderLine);
document.addEventListener('selectionchange', () => { if (document.activeElement === input) renderLine(); });
input.addEventListener('keydown', (e) => {
  if (!echoOn) return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    histPos = Math.max(0, Math.min(history.length, histPos + (e.key === 'ArrowUp' ? -1 : 1)));
    input.value = history[histPos] ?? '';
    input.setSelectionRange(input.value.length, input.value.length);
    renderLine();
  }
});
input.addEventListener('focus', () => term.classList.add('focused'));
input.addEventListener('blur', () => term.classList.remove('focused'));
term.addEventListener('click', () => {
  if (String(getSelection()).length) return; // let people select and copy the output
  input.focus({ preventScroll: true });
});

for (const [label, cmds] of CHIPS) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span>${label}</span>`;
  for (const c of cmds) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = c;
    b.title = 'Send this line';
    b.addEventListener('click', () => { send(c); });
    row.append(b);
  }
  $('chips').append(row);
}

// --- copy ---
async function copyText(btn, text) {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'security-systems.txt';
    a.click();
    URL.revokeObjectURL(a.href);
    btn.textContent = 'Saved';
  }
  setTimeout(() => { btn.textContent = old; }, 1400);
}
$('copy').addEventListener('click', (e) => copyText(e.currentTarget, out.textContent));

$('restart').addEventListener('click', () => {
  append('\n', null);
  worker.postMessage({ type: 'restart' });
  exited = false;
  threadAt = null;
  updateThread();
  setStatus('busy', 'starting');
});
$('reset-disk').addEventListener('click', () => {
  out.textContent = '';
  append('[A fresh disk-model from setup.sh: no users yet.]\n', 'sys');
  const offset = clockOffset;
  startWorker();
  if (offset) worker.postMessage({ type: 'clock', addMs: offset });
});

// --- virtual clock ---
let clockOffset = 0;
const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function updateClock() {
  const days = clockOffset / 86400e3;
  $('clock').innerHTML = `${fmt.format(new Date(Date.now() + clockOffset))}<small>${days ? `the app's time(), ${days > 0 ? '+' : ''}${+days.toFixed(2)} days ahead` : "the app's time(), now"}</small>`;
}
document.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => {
  worker.postMessage({ type: 'clock', addMs: Number(b.dataset.days) * 86400e3 });
}));
$('clock-reset').addEventListener('click', () => worker.postMessage({ type: 'clock', reset: true }));

// --- verification thread ---
function updateThread() {
  const el = $('countdown');
  $('wake').disabled = threadAt === null;
  if (threadAt === null) { el.textContent = exited ? 'stopped (the app exited)' : 'starts with the shell'; return; }
  const s = Math.max(0, Math.ceil((threadAt - performance.now()) / 1000));
  el.textContent = `next challenge in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
$('wake').addEventListener('click', () => worker.postMessage({ type: 'wake' }));
setInterval(() => { updateClock(); updateThread(); }, 1000);

$('fy').addEventListener('input', () => {
  const y = parseFloat($('fy').value);
  $('fx').textContent = y > 0 ? (Math.round((Math.log(y) / 6) * 100) / 100).toFixed(2) : '…';
});

// keep the newest output in view when the layout changes (rotation, window resize)
new ResizeObserver(() => { term.scrollTop = term.scrollHeight; }).observe(term);

updateClock();
renderLine();
startWorker();
