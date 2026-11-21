// Haven ↔ Firebase sync, plus push notifications.
// Each signed-in person has:
//   users/{uid}  their whole Haven state
//   push/{uid}   devices that turned on notifications, and the upcoming reminder times
//                the Cloudflare notifier reads to send them
// The app always saves to the device first; this file mirrors it to the cloud and back.
import { firebaseConfig } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const bridge = window.HavenBridge;

let vapidPublicKey = "";
try { ({ vapidPublicKey } = await import("./push-config.js")); } catch (e) { /* notifications not set up */ }
const pushConfigured = !!vapidPublicKey && vapidPublicKey !== "PASTE_HERE";

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const sync = {
  configured: !!firebaseConfig.apiKey && firebaseConfig.apiKey !== "PASTE_HERE",
  user: null,
  push() {},
  async signIn() { throw { code: "not-configured" }; },
  async signUp() { throw { code: "not-configured" }; },
  async reset() { throw { code: "not-configured" }; },
  async signOut() {},
  async enablePush() { throw { code: "not-configured" }; },
  async disablePush() {},
  async testPush() { throw { code: "not-configured" }; },
  pushState() {
    if (!sync.configured) return "unavailable";
    if (!pushConfigured) return "not-configured";
    if (!sync.user) return "signed-out";
    if (!pushSupported) return isIOS && !standalone ? "open-from-home" : "unsupported";
    if (Notification.permission === "denied") return "denied";
    if (pushBusy) return "busy";
    return deviceSubscribed ? "on" : "off";
  },
  explain(e) {
    const c = (e && e.code || "").replace("auth/", "");
    return ({
      "not-configured": "Sync isn’t set up yet. Add your Firebase settings to firebase-config.js.",
      "invalid-email": "That email doesn’t look right.",
      "invalid-credential": "Email or password is incorrect.",
      "wrong-password": "Email or password is incorrect.",
      "user-not-found": "No account uses that email. Tap Create account instead.",
      "email-already-in-use": "An account already uses that email. Tap Sign in instead.",
      "weak-password": "Use a password with at least 6 characters.",
      "missing-password": "Enter your password.",
      "too-many-requests": "Too many tries. Wait a few minutes, then try again.",
      "network-request-failed": "No internet connection. Try again when you’re online.",
      "unauthorized-domain": "This website isn’t on Firebase’s authorized domains list yet. See step 4D of the setup guide.",
      "permission-denied": "Firebase refused the change. Check the Firestore rules (setup guide, Part 7).",
      "push-denied": "Notifications weren’t allowed. To allow them later, use your device’s Settings → Notifications → Haven.",
      "push-failed": "This device couldn’t turn on notifications. Close Haven, open it again, and try once more."
    })[c] || "Something went wrong (" + (c || (e && e.message) || "unknown") + "). Try again.";
  }
};
let pushBusy = false;
let deviceSubscribed = false;
window.HavenSync = sync;
bridge.refresh();

if (sync.configured) start();

async function start() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(SDK + "firebase-app.js"),
    import(SDK + "firebase-auth.js"),
    import(SDK + "firebase-firestore.js")
  ]);
  const app = initializeApp(firebaseConfig);
  const a = auth.getAuth(app);
  const db = fs.getFirestore(app);

  let ref = null, pushRef = null, unsub = null, unsubPush = null;
  let timer = null, writing = false, again = false, lastPushed = 0;
  let accountHasDevices = false, lastSchedJson = "";

  async function write() {
    if (!ref) return;
    if (writing) { again = true; return; }
    writing = true;
    const st = bridge.getState();
    try {
      await fs.setDoc(ref, { json: JSON.stringify(st), updatedAt: st.updatedAt || Date.now() });
      lastPushed = st.updatedAt;
      await writeSchedule();
    } catch (e) { /* offline: the next save retries */ }
    writing = false;
    if (again) { again = false; write(); }
  }

  // Keep the notifier's list of upcoming reminder times up to date.
  async function writeSchedule(force) {
    if (!pushRef || (!accountHasDevices && !force)) return;
    const sched = bridge.schedule();
    const json = JSON.stringify(sched);
    if (json === lastSchedJson && !force) return;
    const upcoming = sched.map((s) => s.at).filter((t) => t > Date.now() - 10 * 60000);
    await fs.setDoc(pushRef, {
      sched,
      next: upcoming.length ? Math.min(...upcoming) : fs.deleteField()
    }, { merge: true });
    lastSchedJson = json;
  }

  async function deviceSubscription() {
    if (!pushSupported) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function deviceId(sub) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub.endpoint)));
    return "d" + Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function saveDevice(sub) {
    const j = sub.toJSON();
    await fs.setDoc(pushRef, {
      subs: { [await deviceId(sub)]: { endpoint: j.endpoint, keys: j.keys, added: Date.now() } }
    }, { merge: true });
  }

  sync.push = () => { clearTimeout(timer); timer = setTimeout(write, 800); };
  sync.signIn = (email, pass) => auth.signInWithEmailAndPassword(a, email, pass);
  sync.signUp = (email, pass) => auth.createUserWithEmailAndPassword(a, email, pass);
  sync.reset = (email) => auth.sendPasswordResetEmail(a, email);
  sync.signOut = async () => { try { await sync.disablePush(); } catch (e) {} return auth.signOut(a); };

  sync.enablePush = async () => {
    // iOS only allows the permission prompt straight from a tap, so ask before anything else.
    const askPromise = Notification.requestPermission();
    pushBusy = true; bridge.refresh();
    try {
      const perm = await askPromise;
      if (perm !== "granted") throw { code: "push-denied" };
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(vapidPublicKey) });
      await saveDevice(sub);
      deviceSubscribed = true;
      accountHasDevices = true;
      await writeSchedule(true);
    } catch (e) {
      if (e && e.code) throw e;
      console.error(e);
      throw { code: "push-failed" };
    } finally { pushBusy = false; bridge.refresh(); }
  };

  sync.disablePush = async () => {
    const sub = await deviceSubscription();
    if (sub) {
      if (pushRef) { try { await fs.updateDoc(pushRef, { ["subs." + await deviceId(sub)]: fs.deleteField() }); } catch (e) {} }
      try { await sub.unsubscribe(); } catch (e) {}
    }
    deviceSubscribed = false;
    bridge.refresh();
  };

  sync.testPush = async () => {
    if (!pushRef) throw { code: "not-configured" };
    const t = Date.now();
    await fs.setDoc(pushRef, { test: t, next: t }, { merge: true });
  };

  auth.onAuthStateChanged(a, async (user) => {
    sync.user = user;
    if (unsub) { unsub(); unsub = null; }
    if (unsubPush) { unsubPush(); unsubPush = null; }
    ref = null; pushRef = null; accountHasDevices = false; lastSchedJson = "";
    bridge.refresh();
    if (!user) return;

    ref = fs.doc(db, "users", user.uid);
    pushRef = fs.doc(db, "push", user.uid);
    try {
      const snap = await fs.getDoc(ref);
      // On sign-in the cloud copy wins, so a fresh device never overwrites real data.
      if (snap.exists() && snap.data().json) bridge.applyRemote(JSON.parse(snap.data().json));
      else await write();
    } catch (e) { /* offline: keep local copy */ }

    unsub = fs.onSnapshot(ref, (snap) => {
      if (!snap.exists() || snap.metadata.hasPendingWrites) return;
      const d = snap.data();
      const local = bridge.getState();
      if (d.json && (d.updatedAt || 0) > (local.updatedAt || 0) && d.updatedAt !== lastPushed) {
        bridge.applyRemote(JSON.parse(d.json));
      }
    });

    unsubPush = fs.onSnapshot(pushRef, (snap) => {
      const subs = snap.exists() ? snap.data().subs || {} : {};
      accountHasDevices = Object.keys(subs).length > 0;
      writeSchedule().catch(() => {});
    }, () => {});

    // Re-check this device's notification status each time Haven opens.
    if (pushConfigured && pushSupported && Notification.permission === "granted") {
      try {
        const sub = await deviceSubscription();
        deviceSubscribed = !!sub;
        if (sub) await saveDevice(sub);   // keeps the address fresh if the phone changed it
      } catch (e) {}
      bridge.refresh();
    }
  });

  // The schedule is built from "now", so refresh it when Haven comes back to the screen.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) writeSchedule().catch(() => {});
  });
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
