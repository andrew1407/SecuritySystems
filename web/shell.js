// A small POSIX-like shell for the app's system() and popen() calls, over emscripten's in-memory FS.
// Every path goes through FS.lookupPath and FS.open, which check the chmod bits, so the
// permissions the app sets per role (admin, privileged, common user) really apply.
// Like popen(), each command runs in a subshell: `cd` checks the directory but changes nothing.
import * as rsa from './rsa.js';

const ERR = { 2: 'Permission denied', 8: 'Bad file descriptor', 10: 'Device or resource busy', 20: 'File exists', 28: 'Invalid argument',
  31: 'Is a directory', 32: 'Too many levels of symbolic links', 44: 'No such file or directory', 54: 'Not a directory',
  55: 'Directory not empty', 63: 'Operation not permitted', 75: 'Invalid cross-device link' };
const errText = (e) => (e && e.errno !== undefined ? ERR[e.errno] || `Error ${e.errno}` : String(e?.message || e));

const enc = new TextEncoder(), dec = new TextDecoder();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n, w = 2) => String(n).padStart(w, '0');

export const HOME = '/home/user';
export const CWD = HOME + '/SecuritySystems';
export const USER_KEY_BITS = 2048; // `openssl genrsa` cap for keys made in the browser (the app asks for 8192)

const HELP = `Web shell commands (each runs like popen() does, in its own subshell):
  ls [-la] [path...]   cat file...   echo text [> file | >> file]   touch file...
  mkdir [-p] dir...    rmdir dir...  rm [-rf] path...   cp src dst   mv src dst
  chmod mode path...   pwd   cd dir   clear   date   whoami   help
  openssl genrsa | rsa | pkeyutl | rsautl | prime
The app's own commands:
  fftAdd(a, b)  fftMul(a, b)  fftPow(a, b)  generatePrime()
  encrypt <from> <to>   decrypt <from> <to>   (with your RSA keys in disk-model/.admin)
`;

export function createShell(FS, { onBusy = () => {}, print = () => {} } = {}) {
  const abs = (p) => {
    if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1);
    const parts = (p.startsWith('/') ? p : CWD + '/' + p).split('/');
    const out = [];
    for (const s of parts) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
    return '/' + out.join('/');
  };
  const lookup = (p) => FS.lookupPath(abs(p), { follow: true }).node;
  const stat = (p) => FS.stat(abs(p));
  const isDir = (p) => { try { return FS.isDir(stat(p).mode); } catch { return false; } };
  const exists = (p) => { try { lookup(p); return true; } catch { return false; } };
  const canRead = (node) => !FS.nodePermissions(node, 'r');

  function readFile(p) {
    return FS.readFile(abs(p));
  }
  function writeFile(p, data, append = false) {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    const created = !exists(p);
    const s = FS.open(abs(p), append ? 'a' : 'w');
    try { FS.write(s, bytes, 0, bytes.length); } finally { FS.close(s); }
    if (created) FS.chmod(abs(p), 0o644); // umask 022
  }

  function modeString(mode) {
    const t = FS.isDir(mode) ? 'd' : FS.isLink(mode) ? 'l' : FS.isChrdev(mode) ? 'c' : '-';
    let s = t;
    for (let i = 8; i >= 0; i--) s += (mode >> i) & 1 ? 'rwx'[(8 - i) % 3] : '-';
    return s;
  }
  function lsDate(ms) {
    const d = new Date(ms), now = Date.now();
    const recent = Math.abs(now - ms) < 182 * 86400e3;
    return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${recent ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : ' ' + d.getFullYear()}`;
  }
  const sortNames = (a, b) => {
    const ka = a.replace(/^\.+/, '').toLowerCase(), kb = b.replace(/^\.+/, '').toLowerCase();
    return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : 1;
  };

  // --- commands: (args, io) -> status; io.out(text|bytes), io.err(text) ---
  const cmds = {
    help(args, io) { io.out(HELP); return 0; },
    pwd(args, io) { io.out(CWD + '\n'); return 0; },
    whoami(args, io) { io.out('user\n'); return 0; },
    true: () => 0,
    false: () => 1,
    exit: (args) => Number(args[0] || 0),
    clear(args, io) { io.out('\x1b[H\x1b[2J\x1b[3J'); return 0; },
    date(args, io) {
      const d = new Date(Date.now()); // Date.now() follows the page's virtual clock
      const tz = -d.getTimezoneOffset(), tzs = tz === 0 ? 'UTC' : `GMT${tz > 0 ? '+' : '-'}${pad(Math.floor(Math.abs(tz) / 60))}${pad(Math.abs(tz) % 60)}`;
      io.out(`${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${tzs} ${d.getFullYear()}\n`);
      return 0;
    },
    echo(args, io) {
      let nl = true;
      if (args[0] === '-n') { nl = false; args = args.slice(1); }
      io.out(args.join(' ') + (nl ? '\n' : ''));
      return 0;
    },
    cd(args, io) {
      const p = args[0] || HOME;
      try {
        const node = lookup(p);
        if (!FS.isDir(node.mode)) throw { errno: 54 };
        const e = FS.nodePermissions(node, 'x');
        if (e) throw { errno: e };
        return 0;
      } catch (e) { io.err(`sh: 1: cd: can't cd to ${p}\n`); return 2; }
    },
    ls(args, io) {
      let all = false, long = false, dirOnly = false;
      const paths = [];
      for (const a of args) {
        if (a.startsWith('-') && a.length > 1) {
          for (const f of a.slice(1)) {
            if (f === 'a' || f === 'A') all = true; else if (f === 'l') long = true; else if (f === 'd') dirOnly = true;
            else if (f !== '1' && f !== 'h') { io.err(`ls: invalid option -- '${f}'\n`); return 2; }
          }
        } else paths.push(a);
      }
      if (!paths.length) paths.push('.');
      let status = 0;
      const files = [], dirs = [];
      for (const p of paths) {
        try {
          const st = stat(p);
          (FS.isDir(st.mode) && !dirOnly ? dirs : files).push(p);
        } catch (e) { io.err(`ls: cannot access '${p}': ${errText(e)}\n`); status = 2; }
      }
      const row = (path, name) => {
        const st = FS.lstat(abs(path));
        return [modeString(st.mode), FS.isDir(st.mode) ? 2 : 1, 'user', 'user', FS.isDir(st.mode) ? 4096 : st.size, lsDate(+st.mtime), name];
      };
      const printLong = (rows) => {
        const w = [0, 1, 4].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
        for (const r of rows) io.out(`${r[0]} ${String(r[1]).padStart(w[1])} ${r[2]} ${r[3]} ${String(r[4]).padStart(w[2])} ${r[5]} ${r[6]}\n`);
      };
      if (files.length) {
        files.sort(sortNames);
        if (long) printLong(files.map((f) => row(f, f))); else for (const f of files) io.out(f + '\n');
      }
      dirs.sort(sortNames).forEach((d, i) => {
        if (paths.length > 1) io.out(`${files.length || i ? '\n' : ''}${d}:\n`);
        const node = lookup(d);
        if (!canRead(node)) { io.err(`ls: cannot open directory '${d}': Permission denied\n`); status = 2; return; }
        let names = FS.readdir(abs(d)).filter((n) => all || !n.startsWith('.'));
        if (!all) names = names.filter((n) => n !== '.' && n !== '..');
        names.sort(sortNames);
        if (!long) { for (const n of names) io.out(n + '\n'); return; }
        const searchable = !FS.nodePermissions(node, 'x');
        const rows = [];
        let total = 0;
        for (const n of names) {
          const full = n === '.' ? d : n === '..' ? d + '/..' : d + '/' + n;
          if (!searchable && n !== '.' && n !== '..') { rows.push(['?---------'.replace(/-/g, '?'), '?', '?', '?', '?', '           ?', n]); continue; }
          try { const r = row(full, n); total += FS.isDir(FS.lstat(abs(full)).mode) ? 4 : Math.ceil(r[4] / 4096) * 4; rows.push(r); }
          catch (e) { io.err(`ls: cannot access '${d}/${n}': ${errText(e)}\n`); status = 1; }
        }
        if (!searchable) { io.err(`ls: cannot access '${d}': Permission denied\n`); status = 1; }
        io.out(`total ${total}\n`);
        if (rows.length) printLong(rows);
      });
      return status;
    },
    cat(args, io) {
      let status = 0;
      for (const p of args) {
        try {
          if (isDir(p)) throw { errno: 31 };
          io.out(readFile(p));
        } catch (e) { io.err(`cat: ${p}: ${errText(e)}\n`); status = 1; }
      }
      return status;
    },
    touch(args, io) {
      let status = 0;
      for (const p of args) {
        try {
          if (exists(p)) { const t = Date.now(); FS.utime(abs(p), t, t); } else writeFile(p, '');
        } catch (e) { io.err(`touch: cannot touch '${p}': ${errText(e)}\n`); status = 1; }
      }
      return status;
    },
    mkdir(args, io) {
      const parents = args.includes('-p');
      let status = 0;
      for (const p of args.filter((a) => !a.startsWith('-'))) {
        try {
          if (parents) {
            let cur = p.startsWith('/') ? '' : '';
            for (const part of p.split('/')) {
              cur = cur ? cur + '/' + part : part || '/';
              if (!part) continue;
              if (!exists(cur)) FS.mkdir(abs(cur), 0o755);
            }
          } else FS.mkdir(abs(p), 0o755);
        } catch (e) { io.err(`mkdir: cannot create directory '${p}': ${errText(e)}\n`); status = 1; }
      }
      return status;
    },
    rmdir(args, io) {
      let status = 0;
      for (const p of args) {
        try { FS.rmdir(abs(p)); } catch (e) { io.err(`rmdir: failed to remove '${p}': ${errText(e)}\n`); status = 1; }
      }
      return status;
    },
    rm(args, io) {
      let rec = false, force = false;
      const paths = [];
      for (const a of args) {
        if (/^-[rRf]+$/.test(a)) { rec ||= /[rR]/.test(a); force ||= a.includes('f'); } else paths.push(a);
      }
      let status = 0;
      const remove = (p) => {
        if (isDir(p)) {
          if (!rec) throw { msg: 'Is a directory' };
          if (!canRead(lookup(p))) throw { errno: 2 };
          for (const n of FS.readdir(abs(p))) if (n !== '.' && n !== '..') remove(p + '/' + n);
          FS.rmdir(abs(p));
        } else FS.unlink(abs(p));
      };
      for (const p of paths) {
        try {
          if (!exists(p)) { if (force) continue; throw { errno: 44 }; }
          remove(p);
        } catch (e) { io.err(`rm: cannot remove '${p}': ${e.msg || errText(e)}\n`); status = 1; }
      }
      return status;
    },
    cp(args, io) {
      const [src, dst] = args.filter((a) => !a.startsWith('-'));
      if (!dst) { io.err('cp: missing destination file operand\n'); return 1; }
      let data;
      try { if (isDir(src)) { io.err(`cp: -r not specified; omitting directory '${src}'\n`); return 1; } data = readFile(src); }
      catch (e) { io.err(`cp: cannot open '${src}' for reading: ${errText(e)}\n`); return 1; }
      const target = isDir(dst) ? dst + '/' + src.split('/').pop() : dst;
      try { writeFile(target, data); } catch (e) { io.err(`cp: cannot create regular file '${target}': ${errText(e)}\n`); return 1; }
      return 0;
    },
    mv(args, io) {
      const [src, dst] = args;
      if (!dst) { io.err('mv: missing destination file operand\n'); return 1; }
      const target = isDir(dst) ? dst + '/' + src.split('/').pop() : dst;
      try { FS.rename(abs(src), abs(target)); } catch (e) { io.err(`mv: cannot move '${src}' to '${target}': ${errText(e)}\n`); return 1; }
      return 0;
    },
    chmod(args, io) {
      const [mode, ...paths] = args;
      if (!mode || !paths.length) { io.err('chmod: missing operand\n'); return 1; }
      let status = 0;
      for (const p of paths) {
        try {
          const cur = stat(p).mode & 0o7777;
          let next;
          if (/^[0-7]{1,4}$/.test(mode)) next = parseInt(mode, 8);
          else {
            next = cur;
            for (const clause of mode.split(',')) {
              const m = /^([ugoa]*)([+\-=])([rwx]*)$/.exec(clause);
              if (!m) { io.err(`chmod: invalid mode: '${mode}'\n`); return 1; }
              const who = m[1] === '' || m[1].includes('a') ? 'ugo' : m[1];
              let bits = 0;
              for (const w of who) for (const r of m[3]) bits |= { r: 4, w: 2, x: 1 }[r] << { u: 6, g: 3, o: 0 }[w];
              if (m[2] === '+') next |= bits; else if (m[2] === '-') next &= ~bits;
              else { let mask = 0; for (const w of who) mask |= 7 << { u: 6, g: 3, o: 0 }[w]; next = (next & ~mask) | bits; }
            }
          }
          FS.chmod(abs(p), next);
        } catch (e) { io.err(`chmod: cannot access '${p}': ${errText(e)}\n`); status = 1; }
      }
      return status;
    },
    openssl: (args, io) => openssl(args, io),
  };

  // --- openssl, with the options the app (and setup.sh) use ---
  function opts(args, flags) {
    const o = { _: [] };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('-')) {
        const k = a.replace(/^-+/, '');
        if (flags.includes(k)) o[k] = true; else o[k] = args[++i];
      } else o._.push(a);
    }
    return o;
  }
  function loadKey(path, wantPrivate, io) {
    let text;
    try { text = dec.decode(readFile(path)); } catch (e) {
      io.err(`Could not open file or uri for loading ${wantPrivate ? 'private' : 'public'} key from ${path}: ${errText(e)}\n`);
      return null;
    }
    const k = rsa.parsePem(text);
    if (!k || (wantPrivate && !k.private)) { io.err(`Could not find private key from ${path}\n`); return null; }
    return k;
  }
  function openssl(args, io) {
    const [sub, ...rest] = args;
    switch (sub) {
      case 'genrsa': {
        const o = opts(rest, []);
        const asked = Number(o._[0] || 2048);
        const bits = Math.min(asked, USER_KEY_BITS);
        onBusy(`openssl genrsa: making a ${bits}-bit RSA key${asked > bits ? ` (the app asks for ${asked})` : ''}…`);
        const pemText = rsa.privateKeyPem(rsa.generateKey(bits));
        onBusy(null);
        if (o.out) {
          try { writeFile(o.out, pemText); FS.chmod(abs(o.out), 0o600); } catch (e) { io.err(`Can't open "${o.out}" for writing, ${errText(e)}\n`); return 1; }
        } else io.out(pemText);
        return 0;
      }
      case 'rsa': {
        const o = opts(rest, ['pubout', 'pubin', 'noout', 'text', 'check']);
        const k = loadKey(o.in, !o.pubin, io);
        if (!k) return 1;
        if (o.check) { io.out('RSA key ok\n'); }
        if (o.text) io.out(`${k.private ? 'Private' : 'Public'}-Key: (${rsa.bitLength(k.n)} bit)\n`);
        if (o.noout) return 0;
        const text = o.pubout || o.pubin ? rsa.publicKeyPem(k) : rsa.privateKeyPem(k);
        io.err('writing RSA key\n');
        if (o.out) {
          try { writeFile(o.out, text); } catch (e) { io.err(`Can't open "${o.out}" for writing, ${errText(e)}\n`); return 1; }
        } else io.out(text);
        return 0;
      }
      case 'rsautl':
      case 'pkeyutl': {
        if (sub === 'rsautl') io.err("The command rsautl was deprecated in version 3.0. Use 'pkeyutl' instead.\n");
        const o = opts(rest, ['encrypt', 'decrypt', 'pubin']);
        if (!o.encrypt && !o.decrypt) { io.err(`${sub}: use -encrypt or -decrypt\n`); return 1; }
        const k = loadKey(o.inkey, !o.pubin, io);
        if (!k) return 1;
        let data;
        try { if (isDir(o.in)) throw { errno: 31 }; data = readFile(o.in); }
        catch (e) { io.err(`Could not open file or uri for loading input from ${o.in}: ${errText(e)}\n`); return 1; }
        let result;
        try { result = o.encrypt ? rsa.encrypt(k, data) : rsa.decrypt(k, data); }
        catch (e) { io.err(`${sub}: ${o.encrypt ? 'Public' : 'Private'} Key operation error\nerror:${e.message}\n`); return 1; }
        if (o.out) {
          try { writeFile(o.out, result); } catch (e) { io.err(`${o.out}: ${errText(e)}\n`); return 1; }
        } else io.out(result);
        return 0;
      }
      case 'prime': {
        const o = opts(rest, ['generate', 'hex', 'safe']);
        if (o.generate) {
          const p = rsa.generatePrime(Number(o.bits || 0));
          io.out((o.hex ? p.toString(16).toUpperCase() : p.toString()) + '\n');
          return 0;
        }
        for (const v of o._) {
          const n = BigInt(v);
          io.out(`${n.toString(16).toUpperCase()} (${n}) is ${rsa.isProbablePrime(n) ? '' : 'not '}prime\n`);
        }
        return 0;
      }
      default:
        io.err(`Invalid command '${sub || ''}'; type "help" for a list.\n`);
        return 1;
    }
  }

  // --- parsing: words with quotes, `;` / `&&` / `||`, `>` / `>>` redirection, a little globbing ---
  function tokenize(line) {
    const toks = [];
    let cur = null, i = 0;
    const push = () => { if (cur !== null) toks.push(cur); cur = null; };
    while (i < line.length) {
      const c = line[i];
      if (c === ' ' || c === '\t' || c === '\n') { push(); i++; continue; }
      if (c === "'" || c === '"') {
        const j = line.indexOf(c, i + 1);
        if (j < 0) throw new Error(`Syntax error: Unterminated quoted string`);
        cur = (cur ?? { w: '', q: true });
        cur.w += line.slice(i + 1, j); cur.q = true;
        i = j + 1; continue;
      }
      const two = line.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '>>' || (two === '2>' && cur === null)) {
        push();
        if (two === '2>') {
          const m = /^2>(&1|&2|\s*\S+)/.exec(line.slice(i));
          toks.push({ op: '2>', arg: m ? m[1].trim() : '' });
          i += m ? m[0].length : 2; continue;
        }
        toks.push({ op: two }); i += 2; continue;
      }
      if (c === ';' || c === '>' || c === '|' || c === '<' || c === '&') { push(); toks.push({ op: c }); i++; continue; }
      if (c === '\\' && i + 1 < line.length) { cur = cur ?? { w: '' }; cur.w += line[i + 1]; i += 2; continue; }
      cur = cur ?? { w: '' };
      cur.w += c; i++;
    }
    push();
    return toks;
  }
  function glob(word) {
    if (word.q || !/[*?]/.test(word.w)) return [word.w];
    const i = word.w.lastIndexOf('/');
    const dir = i < 0 ? '.' : word.w.slice(0, i) || '/', pat = word.w.slice(i + 1);
    if (/[*?]/.test(dir)) return [word.w];
    try {
      if (!canRead(lookup(dir))) return [word.w];
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      const hits = FS.readdir(abs(dir)).filter((n) => n !== '.' && n !== '..' && re.test(n) && (pat.startsWith('.') || !n.startsWith('.'))).sort(sortNames);
      return hits.length ? hits.map((n) => (i < 0 ? n : word.w.slice(0, i + 1) + n)) : [word.w];
    } catch { return [word.w]; }
  }

  // Runs one command line; returns { out: Uint8Array (stdout, plus stderr when merged), status }.
  function exec(line, { mergeErr = false, print = null } = {}) {
    const chunks = [];
    const emit = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; if (print) print(b); else chunks.push(b); };
    let status = 0;
    let toks;
    try { toks = tokenize(line); } catch (e) { emit(`sh: 1: ${e.message}\n`); return { out: concat(chunks), status: 2 }; }
    // split into simple commands joined by ; && ||
    const list = [];
    let cur = [], join = ';';
    for (const t of toks) {
      if (t.op === ';' || t.op === '&&' || t.op === '||') { list.push({ join, toks: cur }); cur = []; join = t.op; }
      else cur.push(t);
    }
    list.push({ join, toks: cur });
    for (const { join: j, toks: ts } of list) {
      if (j === '&&' && status !== 0) continue;
      if (j === '||' && status === 0) continue;
      if (!ts.length) continue;
      status = runSimple(ts, emit, mergeErr);
    }
    return { out: concat(chunks), status };
  }

  function runSimple(ts, emit, mergeErr) {
    const words = [];
    let redirect = null, errTo = null;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (t.op === '>' || t.op === '>>') {
        const target = ts[++i];
        if (!target || target.op) { emit('sh: 1: Syntax error: newline unexpected\n'); return 2; }
        redirect = { path: target.w, append: t.op === '>>' };
      } else if (t.op === '2>') errTo = t.arg;
      else if (t.op === '|') { emit('sh: 1: pipes are not available in this web shell\n'); return 2; }
      else if (t.op === '<' || t.op === '&') { emit(`sh: 1: '${t.op}' is not available in this web shell\n`); return 2; }
      else words.push(...glob(t));
    }
    const out = [];
    const io = {
      out: (x) => (redirect ? out.push(typeof x === 'string' ? enc.encode(x) : x) : emit(x)),
      err: (x) => {
        if (errTo === '/dev/null') return;
        if (errTo === '&1' && redirect) return out.push(enc.encode(x));
        emit(x);
      },
    };
    if (redirect) {
      try {
        if (isDir(redirect.path)) throw { errno: 31 };
        writeFile(redirect.path, new Uint8Array(0), redirect.append);
      } catch (e) { emit(`sh: 1: cannot create ${redirect.path}: ${errText(e)}\n`); return 2; }
    }
    if (!words.length) return 0;
    const [name, ...args] = words;
    const fn = Object.hasOwn(cmds, name) ? cmds[name] : null;
    let status;
    if (!fn) { io.err(`sh: 1: ${name}: not found\n`); status = 127; }
    else {
      try { status = fn(args, io); } catch (e) { io.err(`${name}: ${errText(e)}\n`); status = 1; }
    }
    if (redirect && out.length) {
      try { writeFile(redirect.path, concat(out), true); } catch (e) { emit(`sh: 1: cannot create ${redirect.path}: ${errText(e)}\n`); return 2; }
    }
    return status;
  }

  const concat = (chunks) => {
    const n = chunks.reduce((s, c) => s + c.length, 0), out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  };

  return {
    exec,
    // popen(cmd, "r") -> the output bytes (the app appends " 2>&1", which merges stderr)
    capture: (cmd) => exec(cmd, { mergeErr: true }).out,
    // system(cmd) -> wait status, with the output going straight to the terminal
    system: (cmd) => exec(cmd, { print }).status << 8,
    abs, writeFile, readFile,
  };
}
