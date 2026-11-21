# Vehicle QR (free, self-hosted)

Stick a QR code on your vehicle. Anyone who scans it can alert you
("wrong parking", "lights on", "emergency"...) without seeing your phone number.

Home page has three roles, like a chat assistant:
- **Vehicle owner** (`/owner`): register vehicles, print QR stickers, get alerts.
- **Service provider** (`/provider`): add customers' vehicle numbers, send service reminders/updates (delivered to the owner's alerts if the owner registered that vehicle).
- **Contact an owner** (`/contact`, or by scanning the sticker): chat-style flow, type the vehicle number, pick the issue, send. No login, no phone number needed.

**Cost: zero.** Node.js + SQLite file + browser Web Push. No paid APIs, no Telegram bot, no SMS.

## Advanced features (all free)

- **Two-way anonymous chat:** after an alert the scanner stays on a chat page; the owner replies from the dashboard. Neither sees the other's number (scanner's number is only shown if they typed it).
- **Document reminders:** set insurance / PUC / service dates per vehicle. Alerts arrive 30, 7 and 1 day before and on the day (checked every 6 hours while the server runs).
- **Away note:** a short message shown to people who scan ("Back at 6 PM").
- **Share location:** scanners can optionally attach their location; you get an OpenStreetMap link.
- **Hindi / English** toggle on the contact page.
- **Installable app (PWA):** open the dashboard on your phone and choose "Add to Home screen". Needs https or localhost.

## Run it

```bash
cd D:\new_prj\vehicle-qr
npm install
npm start
```

Open http://localhost:3000, create an account, add a vehicle, print the sticker.

## Let phones scan the QR (still private, still free)

The QR must point to an address your phone can reach. On your home Wi-Fi:

1. Find your PC's IP (`ipconfig` -> IPv4, e.g. `192.168.1.20`).
2. Start with that address (PowerShell):
   ```powershell
   $env:BASE_URL="http://192.168.1.20:3000"; npm start
   ```
3. Allow Node through Windows Firewall when asked. Re-print stickers after changing BASE_URL.

For scanning from anywhere (when you decide to go public) a free Cloudflare Quick Tunnel
(`cloudflared tunnel --url http://localhost:3000`) gives a free https URL. Set `BASE_URL` to it
and `TRUST_PROXY=1`.

## Free email alerts (no SMS, no WhatsApp)

Every alert, reply, service update and document reminder is also emailed to the owner, using any free SMTP account. Gmail is the easiest:

1. Turn on 2-Step Verification on the Gmail account: https://myaccount.google.com/security
2. Create an App Password (16 letters): https://myaccount.google.com/apppasswords
3. Copy `.env.example` to `.env` in this folder, and fill in `SMTP_USER` (your Gmail) and `SMTP_PASS` (the app password).
4. Run `npm install` once (new dependency), then `npm start`. The console prints `Email alerts: on`.
5. In the dashboard, each owner opens **Email alerts**, enters their address, and types the 6-digit code we email them.

Details: Gmail allows a few hundred emails a day, plenty for this. Each owner is capped at 20 emails an hour. Emails never contain the scanner's phone number. Any other SMTP service works the same way (set `SMTP_HOST` and `SMTP_PORT`).

## Owner alerts

- **Dashboard inbox**: refreshes every 10 seconds.
- **Phone notifications** (Web Push, free): click "Enable phone notifications". Works on
  `localhost` or any `https` address. Plain `http://192.168...` will show the inbox but browsers
  block push there; use the tunnel above for real push on your phone.

## Privacy and safety

- Scan page shows only the last 4 characters of the plate.
- Owner phone is revealed only if you tick "Show Call owner button" for that vehicle.
- Scanners can send 5 alerts per 10 minutes per sticker; logins are rate limited.
- Passwords hashed with scrypt; sessions are signed httpOnly cookies.
- Data lives in `data/app.db` (back it up; never commit it).

## Files

- `server.js` - API, SQLite, push, rate limits
- `public/` - `index.html` role picker, `login.html` owner/provider login, `dashboard.html` owner app, `provider-home.html` provider app, `contact.html` chat-style contact flow (also the QR page), `sticker.html` printable sticker, `sw.js` push worker
