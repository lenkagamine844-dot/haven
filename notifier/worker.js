// Haven notifier — a Cloudflare Worker that sends Haven's reminders as push notifications.
//
// Every minute it asks Firestore which people have a reminder due, sends each one to every
// device that turned notifications on, and remembers what it sent so nothing goes out twice.
//
// Settings it needs (Cloudflare → this Worker → Settings → Variables and Secrets):
//   FIREBASE_SERVICE_ACCOUNT  (Secret)  the whole JSON file from Firebase → Project settings → Service accounts
//   VAPID_KEY                 (Secret)  the "private key" line from Haven's setup.html page
//   SITE_URL                  (Text)    Haven's link, e.g. https://haru-dev.github.io/haven/
// And a Cron Trigger set to:  * * * * *  (every minute)

const LATE_LIMIT_MS = 10 * 60 * 1000;   // a reminder more than 10 minutes late is skipped, not sent
const KEEP_SENT_MS = 2 * 24 * 3600 * 1000;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, Date.now()).catch((e) => console.error("Haven notifier failed:", e && e.stack || e)));
  },

  // Visiting the Worker's link shows whether the setup works. It never shows anyone's reminders.
  async fetch(request, env) {
    const out = { haven: "notifier", firebase: "not checked", vapid: "not checked", site: env.SITE_URL || "missing" };
    try { await vapidKeys(env); out.vapid = "ok"; } catch (e) { out.vapid = "problem: " + e.message; }
    try {
      const fs = await firestore(env);
      const docs = await fs.query({ from: [{ collectionId: "push" }], select: { fields: [{ fieldPath: "next" }] } });
      out.firebase = "ok";
      out.people_with_notifications = docs.length;
    } catch (e) { out.firebase = "problem: " + e.message; }
    return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" } });
  }
};

/* ---------------- One run ---------------- */

export async function run(env, now, deps = {}) {
  const fetcher = deps.fetch || fetch;
  const fs = await firestore(env, fetcher);
  const due = await fs.query({
    from: [{ collectionId: "push" }],
    where: { fieldFilter: { field: { fieldPath: "next" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(now) } } }
  });
  const report = { people: due.length, sent: 0, removedDevices: 0 };
  if (!due.length) return report;

  const vapid = await vapidKeys(env);
  for (const d of due) {
    const r = await handlePerson(d, now, { fs, vapid, env, fetcher });
    report.sent += r.sent; report.removedDevices += r.removed;
  }
  return report;
}

async function handlePerson(docu, now, { fs, vapid, env, fetcher }) {
  const data = docu.data;
  const subs = data.subs || {};
  const sent = Object.assign({}, data.sent || {});
  const sched = Array.isArray(data.sched) ? data.sched : [];
  const messages = [];

  for (const s of sched) {
    if (!s || typeof s.at !== "number" || !s.k) continue;
    if (s.at <= now && s.at > now - LATE_LIMIT_MS && !sent[s.k]) {
      messages.push({ key: s.k, at: s.at, payload: { title: s.t || "Haven", body: s.b || "", tag: s.k } });
    }
  }
  if (typeof data.test === "number" && data.test > now - LATE_LIMIT_MS && !sent["test" + data.test]) {
    messages.push({ key: "test" + data.test, at: data.test, payload: { title: "Haven", body: "Notifications are working. 🌿", tag: "test" } });
  }

  const dead = new Set();
  let delivered = 0;
  const url = env.SITE_URL || "/";
  for (const m of messages) {
    let ok = false;
    for (const [id, sub] of Object.entries(subs)) {
      if (dead.has(id) || !sub || !sub.endpoint || !sub.keys) continue;
      const status = await sendPush(sub, { ...m.payload, url }, vapid, env, fetcher);
      if (status === 404 || status === 410) dead.add(id);   // that device turned notifications off or reinstalled
      else if (status >= 200 && status < 300) { ok = true; delivered++; }
      else console.warn("Push service answered", status, "for", id);
    }
    sent[m.key] = m.at;   // marked even if a device failed, so a broken device can't cause repeats
    if (!ok) console.warn("No device accepted", m.key);
  }

  for (const k of Object.keys(sent)) if (sent[k] < now - KEEP_SENT_MS) delete sent[k];
  const upcoming = sched.filter((s) => s && typeof s.at === "number" && s.at > now && !sent[s.k]).map((s) => s.at);
  const next = upcoming.length ? Math.min(...upcoming) : null;

  const set = { sent };
  const remove = [];
  if (next === null) remove.push("next"); else set.next = next;
  for (const id of dead) remove.push("subs." + id);
  await fs.patch("push/" + docu.id, set, remove);
  return { sent: delivered, removed: dead.size };
}

/* ---------------- Firestore over REST, signed in as the service account ---------------- */

let tokenCache = null;

async function firestore(env, fetcher = fetch) {
  let sa;
  try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || ""); }
  catch { throw new Error("FIREBASE_SERVICE_ACCOUNT is missing or isn't the whole JSON file"); }
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error("FIREBASE_SERVICE_ACCOUNT is missing client_email, private_key or project_id");

  const token = await googleToken(sa, fetcher);
  const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  const headers = { authorization: "Bearer " + token, "content-type": "application/json" };

  return {
    async query(structuredQuery) {
      const res = await fetcher(base + ":runQuery", { method: "POST", headers, body: JSON.stringify({ structuredQuery }) });
      if (!res.ok) throw new Error("Firestore query failed (" + res.status + "): " + (await res.text()).slice(0, 300));
      const rows = await res.json();
      return rows.filter((r) => r.document).map((r) => ({
        id: r.document.name.split("/").pop(),
        data: decodeFields(r.document.fields || {})
      }));
    },
    async patch(path, set, remove = []) {
      const mask = Object.keys(set).concat(remove).map((f) => "updateMask.fieldPaths=" + encodeURIComponent(f)).join("&");
      const res = await fetcher(`${base}/${path}?${mask}&currentDocument.exists=true`, {
        method: "PATCH", headers, body: JSON.stringify({ fields: encodeFields(set) })
      });
      if (!res.ok) throw new Error("Firestore update failed (" + res.status + "): " + (await res.text()).slice(0, 300));
    }
  };
}

async function googleToken(sa, fetcher) {
  const nowS = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.email === sa.client_email && tokenCache.exp > nowS + 120) return tokenCache.token;

  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", b64decode(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const jwt = await signJwt({ alg: "RS256", typ: "JWT" }, {
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: nowS, exp: nowS + 3600
  }, (data) => crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data));

  const res = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt
  });
  if (!res.ok) throw new Error("Google sign-in failed (" + res.status + "): " + (await res.text()).slice(0, 300));
  const j = await res.json();
  tokenCache = { email: sa.client_email, token: j.access_token, exp: nowS + (j.expires_in || 3600) };
  return j.access_token;
}

function decodeValue(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  return undefined;
}
function decodeFields(fields) {
  const o = {};
  for (const k of Object.keys(fields)) o[k] = decodeValue(fields[k]);
  return o;
}
function encodeValue(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === "string") return { stringValue: x };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isSafeInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(x) } };
}
function encodeFields(o) {
  const f = {};
  for (const k of Object.keys(o)) f[k] = encodeValue(o[k]);
  return f;
}

/* ---------------- Web Push (RFC 8291 encryption + RFC 8292 VAPID) ---------------- */

async function vapidKeys(env) {
  let jwk;
  try { jwk = JSON.parse(env.VAPID_KEY || ""); }
  catch { throw new Error("VAPID_KEY is missing or not copied whole"); }
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error("VAPID_KEY is not a private key (copy the line marked Private key)");
  const priv = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const pub = concat(new Uint8Array([4]), b64urlDecode(jwk.x), b64urlDecode(jwk.y));
  return { priv, pubB64: b64url(pub) };
}

export async function sendPush(sub, payload, vapid, env, fetcher = fetch) {
  const endpoint = new URL(sub.endpoint);
  const nowS = Math.floor(Date.now() / 1000);
  const jwt = await signJwt({ typ: "JWT", alg: "ES256" }, {
    aud: endpoint.origin, exp: nowS + 12 * 3600, sub: contactFor(env)
  }, (data) => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.priv, data));

  const body = await encryptPayload(new TextEncoder().encode(JSON.stringify(payload)), sub.keys.p256dh, sub.keys.auth);
  const res = await fetcher(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: `vapid t=${jwt}, k=${vapid.pubB64}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "3600",
      urgency: "high"
    },
    body
  });
  return res.status;
}

function contactFor(env) {
  // Apple requires a real https:// or mailto: contact. Haven's own link works.
  const u = (env.SITE_URL || "").trim();
  return /^https:\/\//.test(u) ? u.replace(/\/+$/, "") : "mailto:haven-notifier@users.noreply.github.com";
}

export async function encryptPayload(plaintext, p256dhB64, authB64) {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const serverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, serverKeys.privateKey, 256));

  const enc = new TextEncoder();
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const padded = concat(plaintext, new Uint8Array([2]));   // 0x02 marks the last (only) record
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/* ---------------- Small helpers ---------------- */

async function signJwt(header, claims, signer) {
  const enc = new TextEncoder();
  const unsigned = b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await signer(enc.encode(unsigned)));
  return unsigned + "." + b64url(sig);
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlDecode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return b64decode(s);
}
