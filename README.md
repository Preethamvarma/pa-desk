# PA Desk v2 — Cloud-synced Personal Assistant Reminder Manager

A lightweight Android-installable **Progressive Web App (PWA)** for an officer's Personal Assistant. The website can be hosted on GitHub Pages. With **Supabase Auth + Database configured**, the same account's tasks synchronize across browsers and phones.

## What changed since v1

- **Cross-browser cloud sync** through an authenticated Supabase account, using row-level security (RLS) to prevent an unrelated account from accessing tasks.
- **Offline cache and pending changes:** edits are saved on the device and queued for upload on reconnect. The next device syncs when online (typically within ~25 seconds, or use **Sync now**). Simultaneous edits to the **same task** are last-write-wins, not collaborative editing.
- **Import v1 tasks:** after the first sign-in in the browser where the old tasks were originally saved, choose **Account → Import browser-only tasks**. Other signed-in devices can then see them. Original browser data is intentionally not deleted.
- **Events have TWO independent dates:** the occasion date (event time optional), and the notification date/time. The default is exactly **one calendar day before at 5:00 PM local time** (e.g. 22 Nov 2026 → 21 Nov 2026 at 5 PM). Both are editable.
- **ICS calendar export for event reminders** creates TWO calendar items: the actual event (an all-day entry if no start time was given), and a separate 5-minute reminder entry at the exact selected date/time, with an attached display alarm.
- **Installable PWA** with 192/512-pixel icons and offline page caching, updated through GitHub Pages. No APK is necessary for standard Android home-screen installation.
- Everything from v1: quick capture (dates in `DD.MM.YYYY` also supported), file handovers, follow-ups, searches, priorities, status, browser alerts while open, backups, Google Calendar link, and .ics export.

## One-time setup: enable the cloud (required for cross-browser sync)

**A static website alone cannot sync data.** The files are intentionally shipped with blank cloud credentials. To turn on syncing:

1. Create a project at **https://supabase.com/dashboard** using an organizationally approved account. Choose the hosting region according to applicable organizational data policies.
2. Open **SQL Editor** and run the complete file `supabase-schema.sql`. It creates `public.pa_tasks`, owner-only RLS policies, and revokes unauthenticated access. **Do not switch off RLS**.
3. In Supabase **Authentication → Providers**, ensure Email is enabled. Email confirmation is recommended. If confirmation is enabled, users must confirm their email before signing in; this web app does not automatically process recovery/confirmation redirect tokens. After confirming, return to PA Desk and sign in normally.
4. Under **Connect** (or Settings → API Keys), copy your project's URL and **publishable key**. Update the provided `config.js`:
   ```js
   window.PA_DESK_CONFIG = {
     supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
     supabasePublishableKey: 'sb_publishable_YOUR_PUBLIC_KEY'
   };
   ```
5. **NEVER put a `sb_secret_...` key or `service_role` key in the website or GitHub!** Only the public publishable key belongs in `config.js`. Supabase Auth and RLS enforce access permissions.
6. Upload the updated website files to GitHub Pages (below). Open the website and choose **Sign in to sync → Create an account**. Use the same confirmed email/password on each of your own browsers and Android devices.
7. On the **original browser with existing PA Desk v1 data**, first export a JSON backup, then log in, open Account, and choose **Import N browser-only tasks**. Once the status reads **All changes synced to cloud**, sign in on another browser and verify the same tasks appear.

For production, also configure account recovery, 2FA where supported, organization-controlled access, secure device storage, backups, revocation, audit logs, retention policy, and authorization to use external cloud services.

## Publish/upgrade website on GitHub Pages

1. Create or open your GitHub repository (for example `pa-desk`). If this is an upgrade, retain the **same repo and GitHub Pages link**.
2. Upload/replace `index.html`, `app.js`, `styles.css`, `cloud.js`, `config.js`, `manifest.webmanifest`, `sw.js`, `icon.svg`, `icon-192.png`, and `icon-512.png`. Commit. Keep `supabase-schema.sql` in the repo as setup reference; it is **not** run by GitHub Pages.
3. In **Settings → Pages**, choose **Deploy from a branch**, **main**, **/(root)**. Open the provided HTTPS address. On update, refresh the app after GitHub Pages finishes redeploying; the updated service worker will refresh its cached files.
4. On Android Chrome, open the HTTPS GitHub Pages link → three-dot menu → **Install app** / **Add to Home screen**. If an **Install app** button appears inside PA Desk, you can use it instead. The installed icon launches like an app; updates are delivered from the web.

## Example: marriage on 22 November 2026

1. Choose **New task → Event / Function**.
2. Enter **Event date: 2026-11-22**. Event start time can stay blank.
3. PA Desk fills **Remind on: 2026-11-21 17:00**. You can change the reminder to another date/time.
4. Save. The task is shown according to the reminder date.
5. For a mobile alert when PA Desk is **closed**, use the task's **.ics** export or **Export calendar (.ics)** and import it to a trusted calendar with notifications enabled. Check that the separate *REMINDER:* entry is present at **21 November, 5 PM**, with its alarm enabled. **Google Calendar** quick links create the event but may not set the custom advance alert automatically; **.ics is preferred** for advance reminders.

A sentence like `Remind me about the marriage on 22.11.2026` in Quick capture also sets this default. Sentences without a clear date stay in **Unscheduled**.

## Important notification limitations

- **Cloud synchronization does not deliver background notifications.** Browser notifications in this build still check only while the website/PWA is running and Android allows it. Closing or suspending it may prevent alerts.
- Importing the generated `.ics` reminder into an approved mobile calendar is the practical closed-app notification workaround. The phone's calendar notifications must be enabled; the calendar provider/OS may treat alarms differently. A calendar import is a copy: edits/deletions in PA Desk do **not** automatically update previously imported calendar entries.
- For truly automatic, centrally scheduled mobile push/email/SMS alerts without calendar imports, a subsequent deployment needs a secure backend job scheduler and a push/messaging service. An APK wrapper **alone does not fix that**.
- GitHub Pages is a public **frontend**, not a private file store. Supabase holds authenticated tasks. Do not upload confidential files or classified/identifiable official content to this demonstration without authorization and security review. Browser session tokens and offline caches are stored on the device; protect/unlock official devices and sign out on shared devices.
- Device date and timezone matter for event reminders. This version interprets dates/times in the **device's local timezone** (for example, Asia/Kolkata). Use the same timezone on all devices.
- Keep periodic JSON backups; free cloud services can have availability, quota, or lifecycle limitations.

## Developer tests

From the folder, with Node.js:

```sh
TZ=Asia/Kolkata node tests/test-logic.cjs
TZ=Asia/Kolkata node tests/test-sync.cjs
```

The second test uses a mocked Supabase API and simulates two independent browser sessions. This is **not** a live database integration test. After configuring your real Supabase project, test account sign-in, task creation, sync across two real browsers, deletion, and calendar-import notification on your own mobile.

## License

MIT. See `LICENSE`.
