# Haven

A gentle checklist, routine and affirmation app. It runs as a web app you add to the Home Screen on iPhone, iPad and Mac, hosted free on GitHub Pages, with sync through Firebase (free Spark plan).

## What's in this folder

| File | What it does |
| --- | --- |
| `index.html` | The whole app |
| `firebase-config.js` | Your Firebase settings go here (step 2) |
| `firebase-sync.js` | Sign-in and syncing |
| `firestore.rules` | Keeps each person's data private (step 2) |
| `push-config.js` | Notification public key goes here |
| `setup.html` | Makes the notification keys |
| `notifier/worker.js` | The Cloudflare Worker that sends notifications (not used by the website itself) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Make it install and open like an app, even offline |

Haven works without step 2: it just saves on that one device. Do step 2 if she wants her iPhone, iPad and Mac to share the same checklists.

---

## 1. Put it on GitHub Pages

1. Go to github.com and sign in (or create a free account).
2. Click **+** (top right) → **New repository**. Name it `haven`, set it to **Public**, and click **Create repository**.
3. On the new repo page, click **uploading an existing file**. Drag in everything from this folder, including the `icons` folder. Click **Commit changes**.
4. Open **Settings** → **Pages**. Under "Build and deployment", set Source to **Deploy from a branch**, Branch to **main** and folder **/ (root)**. Click **Save**.
5. Wait 1–2 minutes and refresh. The page shows your link, like `https://YOUR-USERNAME.github.io/haven/`.

## 2. Set up Firebase for sync

1. Go to console.firebase.google.com and click **Create a project**. Name it `haven`. You can turn off Google Analytics. No payment method is needed.
2. **Add a web app:** on the project home, click the **</>** (Web) icon, name it `Haven`, and leave "Firebase Hosting" unticked. Firebase shows a `firebaseConfig` block. Copy its six values into `firebase-config.js`, replacing each `PASTE_HERE`.
3. **Turn on sign-in:** left menu → **Build** → **Authentication** → **Get started** → **Email/Password** → enable the first switch → **Save**.
4. **Allow your GitHub site:** still in Authentication, open **Settings** → **Authorized domains** → **Add domain**, and enter `YOUR-USERNAME.github.io` (no `https://`, no `/haven`).
5. **Create the database:** left menu → **Build** → **Firestore Database** → **Create database**. Pick a location close to you (for the Philippines, `asia-southeast1` Singapore), then **Start in production mode**.
6. **Add the privacy rules:** in Firestore, open the **Rules** tab, replace everything with the contents of `firestore.rules`, and click **Publish**.
7. Upload the updated `firebase-config.js` to GitHub (repo → **Add file** → **Upload files**, then commit). It replaces the old one.

The config values aren't secret; anyone can see them in a website's code. The rules from step 6 are what stop anyone but her from reading her data.

## 3. Install it on her devices

Do this after GitHub Pages is live.

- **iPhone / iPad:** open the link in **Safari** → tap **Share** → **Add to Home Screen** → **Add**. Open Haven from the new icon.
- **Mac:** open the link in **Safari** → **File** → **Add to Dock**.

Then in Haven, go to **Settings → Sync → Sign in or create account**. Create the account once on the first device, then use **Sign in** with the same email and password on the others.

Note: the Home Screen app keeps its own storage, separate from Safari, so sign in from inside the installed app, not from a Safari tab.

## Updating Haven later

1. Edit the files and upload them to the repo again (they replace the old ones).
2. Open `sw.js` and change `haven-v1` to `haven-v2` (then `v3`, and so on). This tells phones to fetch the new version.
3. On her devices, close and reopen Haven, sometimes twice, to see the update.

Her data isn't affected by updates.

## Good to know

- **Notifications** come from a free Cloudflare Worker (`notifier/worker.js`) that checks every minute. Each device turns them on in Settings → Notifications. iPhone and iPad need iOS 16.4+ and Haven opened from the Home Screen icon. The Worker only knows reminders for the next 14 days, refreshed whenever Haven is opened.
- **Offline:** Haven opens and works without internet. Changes sync the next time it's online.
- **Two devices at once:** the most recent change wins. Editing the same day on two devices within a second or two of each other can drop one of the edits.
- **Free limits:** the Firebase Spark plan allows far more reads and writes per day than one person will use.
