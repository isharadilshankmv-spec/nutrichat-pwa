# NutriChat PWA — Deploy Guide

## Project structure
```
nutrichat-pwa/
├── api/
│   └── chat.js          ← Vercel serverless proxy (keeps API key secret)
├── public/
│   ├── manifest.json    ← PWA manifest
│   └── sw.js            ← Service worker (offline support)
├── src/
│   ├── main.jsx         ← React entry point
│   └── App.jsx          ← Full NutriChat app
├── index.html
├── package.json
└── vite.config.js
```

---

## Step 1 — Create a Vercel account
Go to https://vercel.com and sign up for free (use GitHub, Google, or email).

---

## Step 2 — Deploy the project
1. On the Vercel dashboard click **"Add New Project"**
2. Click **"Upload"** (you don't need GitHub)
3. Drag and drop the entire `nutrichat-pwa` folder
4. Vercel detects it as a Vite project automatically
5. Click **Deploy** — takes about 1 minute
6. You get a URL like `https://nutrichat-xyz.vercel.app`

---

## Step 3 — Add your Anthropic API key
1. Get your key from https://console.anthropic.com → API Keys → Create Key
2. In Vercel dashboard → your project → **Settings** → **Environment Variables**
3. Add a new variable:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** your key (starts with `sk-ant-...`)
4. Click **Save**
5. Go to **Deployments** → click the 3 dots on your latest deploy → **Redeploy**

Your API key is now stored securely on Vercel's servers — it never appears in the app code.

---

## Step 4 — Install on iPhone (must use Safari)
1. Open **Safari** on your iPhone (not Chrome — Apple only allows PWA install from Safari)
2. Go to your Vercel URL
3. Tap the **Share button** (box with arrow at the bottom of Safari)
4. Scroll down and tap **"Add to Home Screen"**
5. Give it a name (e.g. NutriChat) → tap **Add**
6. The icon appears on your home screen ✅

Open it from the home screen — it runs fullscreen like a native app.

---

## Step 5 — Enable notifications
1. Open the app **from your home screen icon** (not from Safari browser)
2. Go to ⚙️ **Settings** → **Reminders**
3. Tap **"Enable Notifications"** → Allow
4. Set your Breakfast, Lunch, Dinner times and toggle on
5. Toggle on the hourly Protein reminder if you want it

> ⚠️ Notifications only work when opened from the home screen icon, not from Safari directly.

---

## Updating the app later
If you want to make changes, edit the files and re-upload the folder to Vercel,
or connect a GitHub repo for automatic deploys on every save.
