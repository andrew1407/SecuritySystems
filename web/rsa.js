// RSA as the openssl CLI does it, in BigInt: key generation, PEM (PKCS#8 / PKCS#1 / SPKI),
// PKCS#1 v1.5 encryption padding (the default of `pkeyutl` and `rsautl`) and prime generation.
// Used by web/shell.js for the `openssl ...` commands the app issues.

const SMALL_PRIMES = (() => {
  const out = [], sieve = new Uint8Array(4000);
  for (let i = 2; i < sieve.length; i++) if (!sieve[i]) { out.push(i); for (let j = i * i; j < sieve.length; j += i) sieve[j] = 1; }
  return out;
})();
const SMALL_BIG = SMALL_PRIMES.map(BigInt);

export const bitLength = (n) => n.toString(2).length;
const byteLength = (n) => Math.ceil(bitLength(n) / 8);

export function randomBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  return b;
}

export const toBig = (bytes) => {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex ? BigInt('0x' + hex) : 0n;
};

export function toBytes(n, len) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const raw = Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));
  if (len === undefined) return raw;
  const out = new Uint8Array(len);
  out.set(raw, len - raw.length);
  return out;
}

function randomBig(bits) {
  const bytes = randomBytes(Math.ceil(bits / 8));
  const extra = bytes.length * 8 - bits;
  bytes[0] &= 0xff >> extra;
  return toBig(bytes);
}

// Left-to-right sliding-window exponentiation.
export function modPow(base, exp, mod) {
  if (mod === 1n) return 0n;
  base %= mod;
  const k = bitLength(exp) > 512 ? 5 : 4;
  const table = [base];
  const b2 = (base * base) % mod;
  for (let i = 1; i < 1 << (k - 1); i++) table.push((table[i - 1] * b2) % mod);
  const bits = exp.toString(2);
  let r = 1n, i = 0;
  while (i < bits.length) {
    if (bits[i] === '0') { r = (r * r) % mod; i++; continue; }
    let j = Math.min(bits.length, i + k);
    while (bits[j - 1] === '0') j--;
    for (let t = i; t < j; t++) r = (r * r) % mod;
    r = (r * table[(parseInt(bits.slice(i, j), 2) - 1) >> 1]) % mod;
    i = j;
  }
  return r;
}

function modInv(a, m) {
  let [r0, r1, s0, s1] = [a % m, m, 1n, 0n];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  if (r0 !== 1n) throw new Error('not invertible');
  return ((s0 % m) + m) % m;
}

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

function millerRabin(n, rounds) {
  const n1 = n - 1n;
  let d = n1, s = 0;
  while (!(d & 1n)) { d >>= 1n; s++; }
  const bits = bitLength(n);
  next: for (let r = 0; r < rounds; r++) {
    let a;
    do a = randomBig(bits - 1); while (a < 2n);
    let x = modPow(a, d, n);
    if (x === 1n || x === n1) continue;
    for (let i = 1; i < s; i++) {
      x = (x * x) % n;
      if (x === n1) continue next;
    }
    return false;
  }
  return true;
}

export function isProbablePrime(n) {
  if (n < 2n) return false;
  for (const p of SMALL_BIG) { if (n === p) return true; if (n % p === 0n) return false; }
  const bits = bitLength(n);
  return millerRabin(n, bits >= 1024 ? 4 : bits >= 512 ? 8 : 20);
}

// A random prime of exactly `bits` bits with the top two bits set (as OpenSSL does), searched upwards
// from a random odd start with a small-prime sieve.
export function generatePrime(bits) {
  if (bits < 3) bits = 3;
  for (;;) {
    let start = randomBig(bits) | (3n << BigInt(bits - 2)) | 1n;
    const rems = SMALL_PRIMES.map((p) => Number(start % BigInt(p)));
    for (let delta = 0; delta < 1 << 16; delta += 2) {
      let ok = true;
      for (let i = 0; i < SMALL_PRIMES.length; i++) {
        const p = SMALL_PRIMES[i];
        if ((rems[i] + delta) % p === 0 && start + BigInt(delta) !== BigInt(p)) { ok = false; break; }
      }
      if (!ok) continue;
      const cand = start + BigInt(delta);
      if (bitLength(cand) !== bits) break;
      if (isProbablePrime(cand)) return cand;
    }
  }
}

export function generateKey(bits) {
  const e = 65537n;
  for (;;) {
    const p = generatePrime(bits - (bits >> 1)), q = generatePrime(bits >> 1);
    if (p === q || gcd(e, p - 1n) !== 1n || gcd(e, q - 1n) !== 1n) continue;
    const n = p * q;
    if (bitLength(n) !== bits) continue;
    const lambda = ((p - 1n) * (q - 1n)) / gcd(p - 1n, q - 1n);
    const d = modInv(e, lambda);
    return { n, e, d, p, q, dp: d % (p - 1n), dq: d % (q - 1n), qinv: modInv(q, p) };
  }
}

// --- DER / PEM ---
const RSA_OID = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

function derLen(n) {
  if (n < 128) return [n];
  const b = [];
  while (n) { b.unshift(n & 0xff); n >>= 8; }
  return [0x80 | b.length, ...b];
}
const tlv = (tag, body) => [tag, ...derLen(body.length), ...body];
const derInt = (n) => { const b = [...toBytes(n)]; if (!b.length || b[0] & 0x80) b.unshift(0); return tlv(0x02, b); };
const derSeq = (...items) => tlv(0x30, items.flat());
const ALG_ID = derSeq(RSA_OID, [0x05, 0x00]);

function derRead(bytes, pos = 0) {
  const tag = bytes[pos];
  let len = bytes[pos + 1], off = pos + 2;
  if (len & 0x80) { const k = len & 0x7f; len = 0; for (let i = 0; i < k; i++) len = len * 256 + bytes[off + i]; off += k; }
  return { tag, start: off, end: off + len };
}
function derChildren(bytes, node) {
  const out = [];
  for (let p = node.start; p < node.end;) { const c = derRead(bytes, p); out.push(c); p = c.end; }
  return out;
}
const intOf = (bytes, node) => toBig(bytes.subarray(node.start, node.end));

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s); };
const pem = (label, der) => `-----BEGIN ${label}-----\n${b64(Uint8Array.from(der)).match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

export function privateKeyPem(k) {
  const rsaKey = derSeq(derInt(0n), derInt(k.n), derInt(k.e), derInt(k.d), derInt(k.p), derInt(k.q), derInt(k.dp), derInt(k.dq), derInt(k.qinv));
  return pem('PRIVATE KEY', derSeq(derInt(0n), ALG_ID, tlv(0x04, rsaKey)));
}

export function publicKeyPem(k) {
  return pem('PUBLIC KEY', derSeq(ALG_ID, tlv(0x03, [0, ...derSeq(derInt(k.n), derInt(k.e))])));
}

// Parses a PEM private or public key; returns null if the text holds no RSA key.
export function parsePem(text) {
  const m = /-----BEGIN ((?:RSA )?(?:PRIVATE|PUBLIC) KEY)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!m) return null;
  let der;
  try { der = Uint8Array.from(atob(m[2].replace(/\s+/g, '')), (c) => c.charCodeAt(0)); } catch { return null; }
  try {
    let top = derRead(der);
    let kids = derChildren(der, top);
    if (m[1] === 'PRIVATE KEY') { top = derRead(der, kids[2].start); kids = derChildren(der, top); }
    if (m[1] === 'PUBLIC KEY') { const bit = kids[1]; top = derRead(der, bit.start + 1); kids = derChildren(der, top); }
    const v = kids.map((c) => intOf(der, c));
    if (m[1].includes('PUBLIC')) return { n: v[0], e: v[1], private: false };
    return { n: v[1], e: v[2], d: v[3], p: v[4], q: v[5], dp: v[6], dq: v[7], qinv: v[8], private: true };
  } catch { return null; }
}

// --- PKCS#1 v1.5 ---
export function encrypt(key, data) {
  const k = byteLength(key.n);
  if (data.length > k - 11) throw new Error('data too large for key size');
  const ps = randomBytes(k - 3 - data.length);
  for (let i = 0; i < ps.length; i++) while (!ps[i]) ps[i] = randomBytes(1)[0];
  const em = new Uint8Array(k);
  em[1] = 2;
  em.set(ps, 2);
  em.set(data, 3 + ps.length);
  return toBytes(modPow(toBig(em), key.e, key.n), k);
}

const decrypted = new Map(); // ciphertext + modulus -> plaintext: RSA decryption is deterministic

export function decrypt(key, data) {
  const k = byteLength(key.n);
  if (data.length !== k) throw new Error('data length is not equal to the key size');
  const id = key.n.toString(36) + ':' + b64(data);
  let em = decrypted.get(id);
  if (!em) {
    const c = toBig(data);
    if (c >= key.n) throw new Error('data too large for modulus');
    const m1 = modPow(c, key.dp, key.p), m2 = modPow(c, key.dq, key.q);
    const h = (key.qinv * (((m1 - m2) % key.p) + key.p)) % key.p;
    em = toBytes(m2 + h * key.q, k);
    if (decrypted.size > 200) decrypted.clear();
    decrypted.set(id, em);
  }
  let i = 2;
  if (em[0] !== 0 || em[1] !== 2) throw new Error('padding check failed');
  while (i < k && em[i] !== 0) i++;
  if (i >= k || i < 10) throw new Error('padding check failed');
  return em.slice(i + 1);
}
