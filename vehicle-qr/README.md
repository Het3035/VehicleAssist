# VehicleAssist

Put a QR sticker on your vehicle. Anyone who needs to reach you (blocked in, lights on, window open) scans it or types your number plate, and you get an alert. **Nobody sees anyone's phone number.**

Free to build and free to run. Node.js, a SQLite file, browser push notifications and your own Gmail. No paid APIs, no SMS, no WhatsApp, no Telegram.

> "VehicleAssist" is the working name. To rename it, search the `public` folder, `server.js` and this file for `VehicleAssist`.

---

## Contents

1. [What it does](#what-it-does)
2. [Quick start](#quick-start)
3. [Use it from your phone on the same Wi-Fi](#use-it-from-your-phone-on-the-same-wi-fi)
4. [Email alerts (free)](#email-alerts-free)
5. [How owners are notified](#how-owners-are-notified)
6. [Stopping spam and pranks](#stopping-spam-and-pranks)
7. [Passwords, reports and the admin page](#passwords-reports-and-the-admin-page)
8. [Settings (`.env`)](#settings-env)
9. [Privacy, deleting data and the law](#privacy-deleting-data-and-the-law)
10. [Pages and API](#pages-and-api)
11. [Project structure](#project-structure)
12. [Backup and restore](#backup-and-restore)
13. [Troubleshooting](#troubleshooting)
14. [Limits and known gaps](#limits-and-known-gaps)
15. [Ideas for later](#ideas-for-later)

---

## What it does

Three kinds of people use it:

| Who | Where | What they do |
|---|---|---|
| **Vehicle owner** | `/owner` | Registers vehicles, prints QR stickers, gets alerts, replies in chat, sets reminders |
| **Service provider** (garage, dealer) | `/provider` | Keeps a customer list of vehicle numbers and sends service reminders and updates |
| **Anyone with a problem** | `/contact` or scanning the sticker | Picks what is wrong, adds an optional message, gets replies. No account needed |

Features:

- **QR stickers** with a print page (`/sticker/<id>`), one per vehicle.
- **Contact by number plate** as well as by QR: type the plate on the home page.
- **Anonymous two-way chat.** The owner replies from the dashboard. The person who scanned sees the reply on the same page. Neither sees the other's number. The scanner's own number is shown to the owner only if the scanner typed it.
- **Reasons to pick from:** wrong or blocking spot, lights or ignition on, window or door open, about to be towed, possible damage, emergency, or a typed message.
- **Optional location share.** The scanner can attach where they are. The owner gets an OpenStreetMap link. (Needs https or localhost, see [limits](#limits-and-known-gaps).)
- **Away note** per vehicle, shown to scanners (for example "Back at 6 PM").
- **Pause alerts** per vehicle for 1, 8 or 24 hours. Messages are still saved.
- **Document reminders:** insurance, PUC and next service dates. Alerts 30, 7 and 1 day before and on the day.
- **Service providers** can message owners of registered vehicles ("Owner on app" or "Not on app yet" is shown per customer).
- **Five languages for the whole site:** English, Hindi, Marathi, Gujarati and Tamil. A language menu sits in the header (and on the contact page). The choice is remembered in the browser, and emails, phone notifications and reminders go out in each owner's language.
- **Installable on a phone** (Add to Home screen) with push notifications.
- **Spam protection** built in. See [below](#stopping-spam-and-pranks).
- **Forgot password** by email code, **report this alert**, an **admin page**, **daily backups**, a **privacy page**, and **download my data as a PDF** and **delete my account**.

---

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer (the LTS version is fine).

```bash
cd D:\new_prj\vehicle-qr
npm install
npm start
```

Open **http://localhost:3000**.

1. Click **Get a sticker for my vehicle**, create an owner account, add a vehicle.
2. Click **Print sticker**. Or click **Preview** to see what a scanner sees.
3. To try the other side, open `/contact` in a private window and type the plate.

To stop the server press **Ctrl+C**. After updating the project files, run `npm install` once (if `package.json` changed), then `npm start` again.

---

## Use it from your phone on the same Wi-Fi

No upload and no hosting needed. Your laptop is the server.

1. Put the laptop and phone on the same Wi-Fi.
2. On the laptop run `ipconfig` and note the **IPv4 Address** of the Wi-Fi adapter, for example `192.168.1.20`.
3. Start the server with that address, so the QR codes contain it.

   PowerShell:
   ```powershell
   cd D:\new_prj\vehicle-qr
   $env:BASE_URL="http://192.168.1.20:3000"; npm start
   ```
   Or put `BASE_URL=http://192.168.1.20:3000` in your `.env` file and just run `npm start`.
4. When Windows Firewall asks about Node.js, choose **Private networks** and Allow. If you missed it: Windows Security, Firewall & network protection, Allow an app through firewall, tick Node.js for Private.
5. On the phone open `http://192.168.1.20:3000`.

Things to know:

- The QR code stores that address. If your laptop's IP changes, restart with the new one and re-print stickers. Giving the laptop a fixed IP in your router settings avoids this.
- The laptop and `npm start` must keep running.
- Guest Wi-Fi networks often block devices from seeing each other. Use the main network.
- Over plain `http://192.168...` browsers block **phone push notifications** and **location sharing**. The inbox, chat, reminders and email alerts all still work. For push and location on a phone, use a tunnel (next section).

### Optional: free https with a Cloudflare tunnel

Nothing is uploaded. Your laptop stays the server, and Cloudflare forwards traffic to it.

1. Install `cloudflared` (free): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. In a second window run `cloudflared tunnel --url http://localhost:3000`. It prints an `https://something.trycloudflare.com` address.
3. Restart the app with `BASE_URL` set to that address and `TRUST_PROXY=1` (put both in `.env`).

The quick-tunnel address changes every time you start it, which breaks printed stickers. For stickers that last, you would need a permanent address (a domain). Check Cloudflare's current terms before relying on this.

---

## Email alerts (free)

Every alert, scanner reply, service update and document reminder is also emailed to the owner, using any free SMTP account. Gmail is the easiest.

1. Turn on 2-Step Verification on the Gmail account: https://myaccount.google.com/security
2. Create an App Password (16 letters): https://myaccount.google.com/apppasswords
3. Copy `.env.example` to a new file named `.env` in the project folder (not `.env.txt`). Fill in `SMTP_USER` (your Gmail) and `SMTP_PASS` (the app password).
4. Run `npm install`, then `npm start`. The console should print `Email alerts: on`.
5. In the dashboard each owner opens **Email alerts**, enters an address, and types the 6-digit code that gets emailed to it.

Details:

- The code check stops anyone pointing alerts at an inbox that is not theirs. Codes expire after 10 minutes and lock after 5 wrong tries.
- Emails never contain the scanner's phone number.
- Each owner gets at most 20 emails per hour.
- Gmail allows about **500 emails per day** on a personal account ([Google's limits](https://support.google.com/mail/answer/22839)). Past that, emails stop for the day. Push and the inbox keep working.
- Any other SMTP service works the same way through `SMTP_HOST` and `SMTP_PORT`.
- Never share or commit `.env`. It holds your app password. It is already in `.gitignore`.

---

## How owners are notified

| Channel | Needs | Notes |
|---|---|---|
| **Dashboard inbox** | Nothing | Updates every 8 seconds while the page is open. Unread count shows in the tab title |
| **Phone/browser push** | Owner clicks **Enable phone notifications**. https or localhost | iPhone needs the site added to the Home Screen first (iOS 16.4+). Desktop browsers must be running |
| **Email** | SMTP set up, owner verified an address | See above |

If an owner has not enabled push or email and is not looking at the dashboard, they will not know about an alert until they open it.

### More than one person per vehicle

One phone missing an alert is the worst thing that can happen, so a vehicle can have up to 5 people (the owner plus 4 more, such as a spouse or driver):

1. The owner opens the vehicle's **Settings and reminders** and taps **Invite someone**. A code like `NR43-2M3G` appears. It works once and lasts 7 days. Only one open invite exists per vehicle.
2. The other person makes their own free account, opens their dashboard, and enters the code under **Join a vehicle**.
3. From then on every alert, reply and reminder for that vehicle goes to **each person's own phone and email, in their own language**. The inbox is shared: reading, replying or dismissing an alert does it for everyone.

No phone numbers are shared when joining. Only the owner can change the vehicle's settings, delete it, block or report senders, and add or remove people. Anyone can stop getting a vehicle's alerts with **Stop getting alerts for this vehicle**.

**Unread urgent alerts are sent again.** If an Emergency or Towing alert is still unread after `ESCALATE_MINUTES` (default 5), everyone on the vehicle gets a second push and email marked "Still unread". Set it to `0` to turn this off.

---

## Stopping spam and pranks

Layers, all automatic:

| Protection | What it does |
|---|---|
| **Cap per vehicle** | At most **4 new alerts per hour** and **12 per day**, from everyone combined. Changing phone or network does not help |
| **Duplicates ignored** | The same problem reported again within 15 minutes is not stored, and the person is thanked |
| **Quiet pings** | After one push or email for a vehicle, more alerts within 2 minutes land in the inbox without pinging again |
| **Pause alerts** | Per vehicle, for 1, 8 or 24 hours. Alerts are saved quietly and scanners are told the owner paused alerts |
| **Block sender** | One tap on an alert hides that sender's earlier and future messages. They are not told. **Unblock all** is under the alerts list |
| **Conversation limit** | 8 follow-up messages per conversation |
| **Network limits** | 5 alerts per 10 minutes per sticker, and 30 per day, per network address |
| **Report** | Owners can report an alert. It is blocked and hidden for them, and once `AUTO_BAN_REPORTS` (default 3) different owners report the same sender, that sender is banned from every vehicle without being told |

How blocking works: each scanner's browser gets a random id cookie, and only a keyed hash of it is stored. Someone who clears cookies or uses a private window looks like a new person, but still runs into the per-vehicle cap, so the worst case is 12 alerts a day. Use **Pause alerts** if one sticker is being targeted.

A real emergency can be refused if the cap has already been used up. This is deliberate: protecting owners from floods comes first.

---

## Passwords, reports and the admin page

**Forgot password.** On the login page choose *Forgot your password?*, enter the phone number, and a 6-digit code is emailed to the address the owner verified under *Email alerts*. The code lasts 10 minutes and locks after 5 wrong tries. Resetting signs the account out on every device. The page gives the same answer whether or not the number exists, so nobody can probe for accounts. An owner who never verified an email cannot use this; the admin sets a temporary password instead (below). Needs email set up.

**Report this alert.** Under each alert from a scanner there is a **Report** button (reason: spam or prank, abusive, fake emergency, other). It also blocks and hides that sender for the owner. Messages from a service provider can be reported too; they are hidden and the admin decides.

**Admin page.** Off until you set `ADMIN_PASSWORD` in `.env` (use a long one) and restart. Then open `/admin`:

- Overview: owners, providers, vehicles, alerts in 24 hours, open reports, banned senders.
- Reports with reporter, reason and message. Actions: **Ban sender everywhere**, **Delete provider account**, **Dismiss**.
- Banned senders, with **Unban**.
- Accounts: search by name, phone or email, set a **temporary password** (shown once, signs the person out everywhere) or **delete** the account.
- Backups: last backups and **Back up now**.

The admin login is limited to 5 tries per 10 minutes and expires after 8 hours. If you put the app on the internet, keep `ADMIN_PASSWORD` strong and use https.

---

## Settings (`.env`)

Copy `.env.example` to `.env`. Real environment variables override the file. All settings are optional.

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `BASE_URL` | `http://localhost:<PORT>` | Address put inside QR codes and email links. Set to your laptop's IP or tunnel address |
| `TRUST_PROXY` | off | Set to `1` when behind a tunnel or proxy, so rate limits see the real visitor address |
| `SMTP_HOST` | none | Mail server, for example `smtp.gmail.com` |
| `SMTP_PORT` | `465` | `465` uses SSL. Other ports use STARTTLS when the server offers it |
| `SMTP_USER` | none | Mail account name |
| `SMTP_PASS` | none | Mail account password or app password |
| `SMTP_FROM` | `VehicleAssist <SMTP_USER>` | Sender shown on emails |
| `ALERT_MAX_PER_HOUR` | `4` | New alerts allowed per vehicle per hour |
| `ALERT_MAX_PER_DAY` | `12` | New alerts allowed per vehicle per day |
| `VAPID_SUBJECT` | `mailto:owner@example.com` | Contact address sent to push services. Set it to your own email |
| `ADMIN_PASSWORD` | none (admin off) | Turns on `/admin` |
| `BACKUP_DIR` | `backups` next to `server.js` | Where daily backups go. Use a folder on another drive, for example `E:\vehicle-backups` |
| `BACKUP_KEEP` | `14` | How many daily backups to keep |
| `MESSAGE_RETENTION_DAYS` | `90` | Alerts and chats older than this are deleted automatically. `0` keeps them forever |
| `AUTO_BAN_REPORTS` | `3` | Different owners who must report one sender before a site-wide ban |
| `ESCALATE_MINUTES` | `5` | Minutes before an unread Emergency or Towing alert is sent again to everyone on the vehicle (`0` = off) |
| `CONTACT_EMAIL` | none | Shown on the privacy page as the address for data questions |

Email is on only when `SMTP_HOST`, `SMTP_USER` and `SMTP_PASS` are all set.

---

## Privacy, deleting data and the law

What the app does:

- The contact page shows only the **last 4 characters** of the plate. An owner's phone number appears **only** if they tick "Show Call owner button". Scanners never see an owner's email.
- Passwords are hashed with scrypt. Sessions are signed, httpOnly cookies (30 days).
- Owners can only see and change their own data. Provider and owner areas are separate.
- Scanner conversations use a long random link kept in the scanner's browser.
- Data is stored in `data/app.db` on your machine. Nothing goes to third parties except push services (to deliver notifications) and your SMTP provider (to send email).
- **Privacy page** at `/privacy`, linked from the footer and the contact page. It describes what the app really keeps. Set `CONTACT_EMAIL` so people know who to write to.
- **Download my data (PDF)** and **Delete my account** on both dashboards. The PDF lists the account, vehicles, alerts, conversations (or customers, for providers) and handles Hindi, Marathi, Gujarati and Tamil text. Deleting needs the password and erases vehicles, alerts, chats, customers, push settings and blocks at once. Old backups drop the data when they expire (14 days by default).
- **Automatic deletion** of alerts and chats after `MESSAGE_RETENTION_DAYS` (90 by default).

The legal side (check before real strangers use it). This is not legal advice:

- If you offer this to the public, you hold other people's phone numbers and emails. India's Digital Personal Data Protection Act, 2023 is the law to check. Its "personal or domestic purpose" exemption is for private use, so a public service probably does not qualify. The DPDP Rules were notified in November 2025 and switch on in stages over about 18 months, so the main duties (clear notice, consent, deletion on request, breach reporting) land around mid-2027. Confirm the dates and what applies to you.
- The privacy page is written to be accurate for this app. Read it, edit it, and keep it true if you add features.
- Practical habits: collect nothing extra, keep the retention short, answer deletion requests, and keep the `data` and backup folders private.
- For a family or friends-only test on your own Wi-Fi, none of this is a concern.

---

## Pages and API

Pages:

| Address | Page |
|---|---|
| `/` | Home: plate box, how it works, FAQ |
| `/owner`, `/provider` | Log in or create an account (owner or provider) |
| `/dashboard` | Owner dashboard |
| `/provider/dashboard` | Provider dashboard |
| `/contact` | Contact an owner by plate number |
| `/v/<token>` | The page a QR sticker opens |
| `/sticker/<id>` | Printable sticker |
| `/privacy` | Privacy notice |
| `/admin` | Admin page (needs `ADMIN_PASSWORD`) |

API (JSON). Owner routes need an owner login, provider routes need a provider login:

```
Auth        POST /api/register  /api/login  /api/logout      GET /api/me
Vehicles    GET/POST /api/vehicles        PATCH/DELETE /api/vehicles/:id        GET /api/vehicles/:id/qr.svg
Inbox       GET /api/messages             POST /api/messages/read
            POST /api/messages/:id/reply  POST /api/messages/:id/block          DELETE /api/messages/:id
            GET/DELETE /api/blocks
            GET /api/vehicles/:id/people, POST /api/vehicles/:id/invite, DELETE /api/vehicles/:id/people/:uid
            POST /api/vehicles/:id/leave, POST /api/join
Push        GET /api/push/key             POST /api/push/subscribe
Email       POST /api/email/start         POST /api/email/verify                DELETE /api/email
Provider    GET/POST /api/provider/customers      DELETE /api/provider/customers/:id
            POST /api/provider/customers/:id/notify
Reset       POST /api/reset/start         POST /api/reset/finish
Reports     POST /api/messages/:id/report
Account     GET /api/account/export.pdf   GET /api/account/export (JSON)   DELETE /api/account   GET /api/site
Admin       POST /api/admin/login|logout  GET /api/admin/overview|reports|bans|users
            POST /api/admin/reports/:id/ban|dismiss     POST /api/admin/bans/remove
            POST /api/admin/users/:id/delete|password   POST /api/admin/backup
Public      GET /api/public/:token        POST /api/public/:token/alert
            POST /api/contact/lookup
            GET/POST /api/thread/:token   (the scanner's own conversation)
```

---

## Project structure

```
vehicle-qr/
  server.js           API, database, push, email, reminders, rate limits, admin
  env.js              Loads the .env file
  backup.js           Daily database backup (also: npm run backup)
  fonts/              Fonts used only to draw the PDF (open-source; Latin, Devanagari, Gujarati, Tamil)
  package.json        Dependencies: express, better-sqlite3, qrcode, web-push, nodemailer, pdfkit
  .env.example        Settings template (copy to .env)
  data/               Created on first run: app.db (your database)
  backups/            Created on first run: daily copies of app.db (or BACKUP_DIR)
  public/
    index.html            Home page
    login.html            Owner / provider login and password reset
    admin.html            Admin page
    privacy.html          Privacy notice
    account.js            Download / delete my data card
    dashboard.html        Owner app
    provider-home.html    Provider app
    contact.html          Chat-style contact page (also the QR page)
    sticker.html          Printable sticker
    style.css             One stylesheet for all pages
    site.js               Shared header, footer and language menu
    i18n.js               All site text in 5 languages (also used by the server)
    sw.js                 Push notifications and offline fallback
    manifest.webmanifest  Makes it installable on a phone
    icon-192.png, icon-512.png
    fonts/                Self-hosted fonts (SIL Open Font License)
```

The pages reference `style.css?v=4` and `site.js?v=5`. If you change those files and a browser keeps the old version, increase the number in the HTML files.

---

## Languages and how to add one

All site text lives in one file, `public/i18n.js`: a short list of keys with one block per language (`en`, `hi`, `mr`, `gu`, `ta`). Pages mark text with `data-i="key"`, and the same file translates emails, phone notifications and reminders on the server. Anything missing in a language falls back to English, so a half-finished translation never breaks a page.

To change a wording, edit the line for that key and press Ctrl+F5. To add a language:

1. Add it to `LANGS` and `D` at the top of `public/i18n.js`, then add a block with every key.
2. If its script is not Latin, Devanagari, Gujarati or Tamil, add a self-hosted font in `public/fonts/` and a font-face in `style.css`, and a TTF in `fonts/` for the PDF export.

The translations here were written to be clear and plain, but a native speaker should read them before you rely on them for real users. Short, friendly fixes are welcome in the file itself.

## Backup and restore

The server makes **one backup per day** automatically (when it starts, then checked hourly) and keeps the newest 14 (`BACKUP_KEEP`). Files are named `app-2026-11-21.db`. The copy is made with SQLite's own backup, so it is safe while the app is running. The admin page lists them and has **Back up now**.

**Put backups on another drive.** The default folder is next to `server.js`, which does not protect you from a dead disk. Set `BACKUP_DIR` in `.env`, for example `BACKUP_DIR=E:\vehicle-backups`, or a folder that OneDrive or Google Drive syncs.

**Backups contain password hashes and keys.** Keep that folder private and never upload it anywhere public.

**If the server is not running every day,** also run it from Windows Task Scheduler: create a daily task that runs `npm run backup` in the project folder (action: *Start a program*, program `cmd`, arguments `/c cd /d D:\new_prj\vehicle-qr && npm run backup`).

**Restore:** stop the server, delete everything inside `data`, copy the backup you want into `data` and rename it to `app.db`, then start the server. Restoring also restores the session and push keys, so people stay signed in.

Do not delete `data` unless you want to start from nothing.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **The design looks old** | Press Ctrl+Shift+R. If it persists, open developer tools (F12), Application, Storage, **Clear site data**, then reload |
| **"Email is not turned on for this server yet"** | The server is an older copy, or `.env` is missing values. Stop it, run `npm install`, run `npm start`, and look for `Email alerts: on` in the console |
| **`Email alerts: off`** | `SMTP_HOST`, `SMTP_USER` and `SMTP_PASS` must all be filled in. The file must be named `.env`, not `.env.txt`. No spaces around `=` |
| **`Email failed: ...` in the console** | Usually a wrong app password, or 2-Step Verification is not on |
| **`Cannot find module ...`** | Run `npm install` in the project folder |
| **`npm install` fails on `better-sqlite3`** | Use the current Node.js LTS release, which has ready-made binaries. Then run `npm install` again |
| **Port 3000 already in use** | An old server is still running. Close it, or start with another port: `$env:PORT=3001; npm start` |
| **Phone cannot open the address** | Same Wi-Fi? Firewall allowed for Private networks? Not on a guest network? Correct IP from `ipconfig`? |
| **"Too many attempts"** | You hit a rate limit (for example 10 logins in 10 minutes). Wait, or restart the server while testing |
| **Notifications do not appear** | Needs https or localhost, and the owner must click Enable phone notifications and allow them in the browser |
| **QR opens `localhost`** | `BASE_URL` was not set when the server started. Set it and re-print the stickers |

---

## Limits and known gaps

- **Password reset needs a verified email.** Owners without one need the admin to set a temporary password.
- **Accounts are not verified by phone** (SMS is not free in India). Email verification is optional.
- **The laptop must stay on.** There is no hosting. Scanning only works while the server is reachable.
- **Push and location need https or localhost.**
- **Emails are not retried** if sending fails, and are capped by Gmail at about 500 a day.
- **Reminders** are checked every 6 hours while the server runs. If the server is off on the day, the reminder arrives when it next starts.
- **Blocking uses a browser cookie**, so a determined person can get around it. The per-vehicle cap still limits the damage.
- A deleted person can register again. Bans apply to scanner browsers, not phone numbers.
- Backups are only as safe as the place you put them.

---

## Ideas for later

Quiet hours, sticker sheets (many stickers per page), photo of the problem, more languages (see "Adding a language"), and CSV import for service providers.
