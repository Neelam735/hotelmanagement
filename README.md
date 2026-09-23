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
| 🍽️ Food & drinks to the room | Kitchen |
| 🔧 Something not working (AC, plumbing, lights, TV, Wi-Fi, lock…) | Maintenance |
| ⏰ Wake-up call | Front desk |
| 🕐 Late checkout | Front desk |
| 🚕 Taxi / airport transfer | Front desk |
| 💬 Free-text message to reception | Front desk |

Guests can also:

- Turn on **Do Not Disturb**. Staff see it on every request from that room.
- Follow the status of each request live (Sent → Seen by staff → On the way → Done) and read replies from staff. Each phone sees only the requests made from it.
- Cancel a request before staff have started on it.
- See the hotel Wi-Fi details and the reception phone number for emergencies.

## What staff can do

- **Live dashboard** (`/staff`): new requests appear immediately with a sound alert. Staff can acknowledge, start, complete, cancel or reopen a request, and send the guest a reply.
- Filter by **department**. A staff member assigned to a department sees that department's requests by default.
- **Rooms tab**: see open requests and Do Not Disturb for each room. Press **New guest (reset)** at checkout. This clears Do Not Disturb, cancels open requests and hides the previous guest's history from the room page.

## What admins can do

Admins use the admin page (`/admin`):

- Add rooms one at a time or as a range (for example 101–120).
- **Print QR codes**: a printable sheet with one card per room.
- **New QR**: replace a room's QR code if it was copied or photographed. The old code stops working.
- Manage staff accounts (department, and staff or admin role).
- Set the hotel name, welcome message, reception phone and Wi-Fi details.

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

1. **Hotel settings**: enter the hotel name, reception phone and Wi-Fi.
2. **Rooms & QR codes**: add your rooms.
3. **Print all QR codes** and place each card in its room.
4. **Staff**: create accounts for housekeeping, laundry, kitchen, maintenance and front desk.
5. Keep `/staff` open on a screen at reception (and on staff phones).

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | taken from the incoming request | Public address encoded in the QR codes, e.g. `https://rooms.myhotel.com`. **Set this in production.** |
| `DB_FILE` | `data/hotel.db` | SQLite database file |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / random | First admin account (used only when the database is empty) |
| `SECURE_COOKIES` | `false` | Set `true` when served over HTTPS |
| `TRUST_PROXY` | off | Set, for example to `1`, when running behind a reverse proxy or load balancer |

Guests' phones must be able to reach the server. That means either a public
HTTPS address, or the hotel's guest Wi-Fi network if you host it locally.

## Security notes

- Each QR code contains a random, unguessable token rather than the room number, so a guest cannot send requests for other rooms.
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
  services.js  catalog of guest services + input validation
  db.js        SQLite schema
  auth.js      staff login and sessions
  events.js    Server-Sent Events hub for live updates
public/        guest page, staff dashboard, admin and QR print pages (plain HTML/JS)
test/          API tests
```

To add or change a service (for example "Spa booking"), edit `src/services.js`.
The guest form, validation and dashboard pick up the change automatically.
