// Haven ↔ Firebase sync.
// Each signed-in person has one Firestore document, users/{uid}, holding their whole Haven state.
// The app always saves to the device first; this file mirrors it to the cloud and back.
import { firebaseConfig } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const bridge = window.HavenBridge;

const sync = {
  configured: !!firebaseConfig.apiKey && firebaseConfig.apiKey !== "PASTE_HERE",
  user: null,
  push() {},
  async signIn() { throw { code: "not-configured" }; },
  async signUp() { throw { code: "not-configured" }; },
  async reset() { throw { code: "not-configured" }; },
  async signOut() {},
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
      "unauthorized-domain": "This website isn’t on Firebase’s authorized domains list yet. See step 3 of the setup guide."
    })[c] || "Something went wrong (" + (c || "unknown") + "). Try again.";
  }
};
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

  let ref = null, unsub = null, timer = null, writing = false, again = false, lastPushed = 0;

  async function write() {
    if (!ref) return;
    if (writing) { again = true; return; }
    writing = true;
    const st = bridge.getState();
    try {
      await fs.setDoc(ref, { json: JSON.stringify(st), updatedAt: st.updatedAt || Date.now() });
      lastPushed = st.updatedAt;
    } catch (e) { /* offline: the next save retries */ }
    writing = false;
    if (again) { again = false; write(); }
  }

  sync.push = () => { clearTimeout(timer); timer = setTimeout(write, 800); };
  sync.signIn = (email, pass) => auth.signInWithEmailAndPassword(a, email, pass);
  sync.signUp = (email, pass) => auth.createUserWithEmailAndPassword(a, email, pass);
  sync.reset = (email) => auth.sendPasswordResetEmail(a, email);
  sync.signOut = () => auth.signOut(a);

  auth.onAuthStateChanged(a, async (user) => {
    sync.user = user;
    if (unsub) { unsub(); unsub = null; }
    ref = null;
    bridge.refresh();
    if (!user) return;

    ref = fs.doc(db, "users", user.uid);
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
  });
}
