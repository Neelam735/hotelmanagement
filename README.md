# Hotel QR Room Services

Replace the in-room extension phone with a QR code. Guests scan the code in
their room with their phone camera. No app or login is needed. They can then
request anything they would normally phone reception for. Staff see each
request instantly on a live dashboard.

## What guests can do

| Service | Goes to |
| --- | --- |
| 🧹 Room cleaning (now, within 1 hour, while out, at a set time) | Housekeeping |
| 🧴 Towels & amenities (towels, toiletries, pillows, blankets, water, iron…) | Housekeeping |
| 👕 Laundry (wash & fold, iron, dry cleaning; standard or express) | Laundry |
| 🍽️ Food & drinks: order from the hotel's menu with a cart and live total (or free text if there's no menu yet) | Kitchen |
| 🔧 Something not working (AC, plumbing, lights, TV, Wi-Fi, lock…) | Maintenance |
| ⏰ Wake-up call (today or tomorrow) | Front desk |
| 🕐 Late checkout | Front desk |
| 🚕 Taxi / airport transfer (today or tomorrow) | Front desk |
| 💬 Free-text message to reception | Front desk |

Before using the page, a guest enters the room's 4-digit **room code**. They do this once per stay, and the code changes at every checkout (see below).

Guests can also:

- Turn on **Do Not Disturb**. Staff see it on every request from that room.
- Follow the status of each request live (Sent → Seen by staff → On the way → Done) and read replies from staff. Each phone sees only the requests made from it. Timed requests show when they're scheduled for, e.g. "Tomorrow 06:00".
- Cancel a request before staff have started on it.
- See the hotel Wi-Fi details and the reception phone number for emergencies.

## What staff can do

- **Live dashboard** (`/staff`): new requests appear immediately with a sound alert. Staff can acknowledge, start, complete, cancel or reopen a request, and send the guest a reply.
- **Reminders so nothing is missed.** Wake-up calls, taxis and cleaning at a set time have a due time. The dashboard alerts staff 5 minutes before it, shows a red "needs attention now" banner, and **beeps every minute** until someone starts or completes the request.
- **Overdue alerts.** A request nobody has picked up within 10 minutes (configurable) turns red and beeps as well. So does a timed request still open 15 minutes after its due time.
- Filter by **department**. A staff member assigned to a department sees that department's requests and alerts by default.
- **Rooms tab**: see each room's code, open requests and Do Not Disturb. **New guest (reset)** at checkout shows the next guest's room code; it also clears Do Not Disturb, cancels open requests and signs out the previous guest's phones. **New code** gives the current guest a different code, for example if someone overheard it.

> Keep the dashboard open on a screen at reception with the sound on. Browsers only play sound after someone has clicked the page once; the **Sound** button turns orange and says "Click to enable sound" until then.

### Check-in workflow

1. At check-in, open **Rooms** on the dashboard and give the guest the room's code. For example, write it on the key card envelope.
2. The guest scans the QR code in the room and enters the code once.
3. At checkout, press **New guest (reset)**. The previous guest's phones are signed out, and the dashboard shows the code for the next guest.

The room code can be turned off under **Hotel settings**, but then anyone who once scanned the room's QR code can keep sending requests.

## What admins can do

Admins use the admin page (`/admin`):

- Add rooms one at a time or as a range (for example 101–120).
- **Print QR codes**: a printable sheet with one card per room.
- **New QR**: replace a room's QR code if it was copied or photographed. The old code stops working.
- **Food menu**: add items with category, price, description and an optional veg / non-veg marker. Untick **Available** to hide an item for the day. Orders keep the price at the time of ordering.
- Manage staff accounts (department, and staff or admin role).
- Set the hotel name, welcome message, reception phone and Wi-Fi details, plus the **hotel time zone**, the **overdue limit**, the **room code** on/off switch and the **currency**.

## Running it

Requires **Node.js 22.5+**. It uses the built-in `node:sqlite`, so there is no database server to install.

```bash
npm install
ADMIN_PASSWORD='choose-a-strong-password' npm start
```

Open <http://localhost:3000/admin> and sign in as `admin`. If you don't set
`ADMIN_PASSWORD`, a random password is generated on first start and printed
in the console.

First-time setup:

1. **Hotel settings**: enter the hotel name, reception phone and Wi-Fi, and check the **time zone**. Servers often run on UTC; wake-up calls use the time zone set here.
2. **Rooms & QR codes**: add your rooms.
3. **Print all QR codes** and place each card in its room.
4. **Food menu**: add your in-room dining menu.
5. **Staff**: create accounts for housekeeping, laundry, kitchen, maintenance and front desk.
6. Keep `/staff` open on a screen at reception (and on staff phones), with sound on.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port (Railway sets this) |
| `PUBLIC_URL` | `https://$RAILWAY_PUBLIC_DOMAIN` on Railway, otherwise the address the admin page was opened with | Public address encoded in the QR codes, e.g. `https://rooms.myhotel.com`. **Set this if you use your own domain.** |
| `DB_FILE` | `$RAILWAY_VOLUME_MOUNT_PATH/hotel.db` on Railway, otherwise `data/hotel.db` | SQLite database file |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / random | First admin account (used only when the database is empty) |
| `HOTEL_TIMEZONE` | server time zone | Initial hotel time zone, e.g. `Asia/Kolkata` (can be changed later under Hotel settings) |
| `SECURE_COOKIES` | `true` on Railway, otherwise `false` | Set `true` when served over HTTPS |
| `TRUST_PROXY` | `1` on Railway, otherwise off | Number of reverse proxies in front of the app |

Guests' phones must be able to reach the server. That means either a public
HTTPS address, or the hotel's guest Wi-Fi network if you host it locally.

## Deploying on Railway

The app is ready for [Railway](https://railway.com): `railway.json` sets the start
command, a health check (`/healthz`) and restart policy. Railway's own variables
set the public address, HTTPS cookies and proxy handling automatically.

1. **Create the service.** On Railway, choose **New Project → Deploy from GitHub repo** and pick this repository. If Railway doesn't pick the right branch, set it under the service's **Settings → Source**.
2. **Add a volume. Don't skip this.** Open the service, press **⌘K / Ctrl+K**, choose **Add Volume**, and set the mount path to `/data`. The database lives on this volume. Without it, **all rooms, staff and requests are erased on every deploy**, and the deploy log shows a warning.
3. **Set variables** under the service's **Variables** tab:
   - `ADMIN_PASSWORD`: a strong password for the first admin login.
   - `HOTEL_TIMEZONE`: e.g. `Asia/Kolkata`. Railway servers run on UTC, and wake-up calls use this setting.
4. **Get a public address.** Under **Settings → Networking**, press **Generate Domain**, or add your own domain. With your own domain, also set `PUBLIC_URL`, e.g. `https://rooms.yourhotel.com`, so the QR codes use it.
5. **Deploy.** When it's live, open `https://<your-domain>/admin`, sign in as `admin`, and follow the first-time setup above.

**Print QR codes only after the final domain is set up.** The domain is inside the QR
codes: if it changes later, reprint them (Admin → Print all QR codes).

Notes:
- Run a **single instance** (Railway's default). The database is a file on the volume, and live updates are sent from one process.
- Railway may cut long-lived connections now and then. The dashboard and guest pages reconnect by themselves and catch up on anything they missed.
- Back up the volume: turn on scheduled backups in the volume's settings if your Railway plan includes them, or copy `/data/hotel.db` out using `railway ssh`.

## Security notes

- Each QR code contains a random, unguessable token rather than the room number, so a guest cannot send requests for other rooms.
- **Room code**: a guest must enter the room's 4-digit code before using the page. The code changes at every checkout, so previous guests are locked out, and their open pages disconnect. Guessing is limited to 10 wrong codes per room every 15 minutes; issuing a new code lifts the block.
- A room's QR link stays the same from one guest to the next, so each phone gets its own random ID in a cookie. A guest sees, cancels and receives live updates only for requests made from their own phone. A previous guest who reopens the link cannot see the next guest's requests.
- Each phone can have at most 10 open requests, and each room can send at most 30 requests per hour. A copied code can neither flood the dashboard nor lock the real guest out. Use **New QR** to revoke a leaked code; open pages using the old link stop receiving updates.
- Staff sign-in is blocked for 15 minutes after 10 failed attempts. Changing a password signs out that account's other devices, and a signed-out dashboard stops receiving live updates.
- Staff passwords are hashed with scrypt. Sessions use HttpOnly, SameSite=Strict cookies. State-changing API calls must be JSON, and a strict Content-Security-Policy is sent.
- Pages build everything guests type as DOM text, never as HTML.

## Development

```bash
npm run dev   # restart on file changes
npm test      # API tests (node:test)
```

Project layout:

```
src/
  server.js    entry point (reads env vars)
  app.js       Express app: guest, staff and admin APIs
  services.js  catalog of guest services + input validation (incl. menu cart)
  schedule.js  turns "06:00 tomorrow" into an exact time in the hotel's time zone
  db.js        SQLite schema
  auth.js      staff login and sessions
  events.js    Server-Sent Events hub for live updates
public/        guest page, staff dashboard, admin and QR print pages (plain HTML/JS)
test/          API tests
```

To add or change a service (for example "Spa booking"), edit `src/services.js`.
The guest form, validation and dashboard pick up the change automatically.
