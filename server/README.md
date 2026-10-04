# 📲 CRISP AND CLOUD — WhatsApp Order Bridge

Node.js + [Baileys](https://github.com/WhiskeySockets/Baileys) service that forwards every
new order from the admin panel to the restaurant's WhatsApp, with a tap-to-open
Google Maps location link.

New orders are formatted like this in WhatsApp:

```
╭───────────────────────────────╮
   🍽️  *NEW ORDER RECEIVED*
╰───────────────────────────────╯

*📋 ORDER DETAILS*
──────────────────────────────────
Order ID                 #XY7QR2PL
Received     04 Oct 2026, 11:52 pm
Payment           Cash on Delivery
Items                            5

*👤 CUSTOMER*
──────────────────────────────────
Name                  Rahul Sharma
Phone              +91 98765 43210
WhatsApp https://wa.me/919876543210

*🛒 ORDERED ITEMS*
──────────────────────────────────
1. *Chicken Dum Biryani*
   Qty 2 × ₹299               ₹598
   ⏱ 30-35 min
...

*📍 DELIVERY LOCATION*
──────────────────────────────────
Flat 402, Sunrise Residency, Near
City Mall, Sindh Bhavan Road,
Ahmedabad, Gujarat 380059

*Open in Google Maps:*
https://www.google.com/maps/search/?api=1&query=22.3569,73.1812
```

---

## Setup

```bash
cd server
npm install
npm start
```

The server listens on **http://localhost:3000**.

### First-time QR pairing

1. Keep the server running (`npm start`).
2. Open the app → Admin → **📲 WhatsApp Alerts**.
3. On the phone that should receive orders, open WhatsApp →
   **⋮ → Linked devices → Link a device**.
4. Scan the QR shown in the admin panel.

The session is saved in `server/.wa-session/`, so this is a one-time step —
the server reconnects on its own after restarts.

---

## How an order flows

```
Customer places order
        │
        ▼
Firestore  status = 'pending',  waSentAt = null
        │
        ├──▶ Admin panel Orders list shows it
        │      (that list queries ONLY status == 'pending')
        │
        ▼
Admin panel sends it to WhatsApp via this bridge
        │
   ┌────┴─────────────────────────────┐
   │ SUCCESS                          │ FAILURE
   ▼                                  ▼
status = 'ordered'               status stays 'pending'
waSentAt = <timestamp>           → STILL visible in admin panel
   │                              → retried with backoff
   │                                 30s → 60s → 2m → 4m → 5m (capped)
   ▼                              → never dropped silently
Removed from admin panel
Customer sees "✅ Ordered"
```

The order disappearing from the admin panel **is** the delivery confirmation —
it only leaves once WhatsApp has accepted the message.

**Retries are endless.** A failed order stays in the admin panel and keeps
retrying (every 5 min at most) until it succeeds. Orders that failed while the
admin panel was closed are picked up automatically the next time it is opened,
because the panel dispatches every pending unsent order — not just new ones.

### Status values

| Status | Meaning | Where visible |
| --- | --- | --- |
| `pending` | Alert not delivered yet | Admin panel queue |
| `ordered` | Alert delivered to WhatsApp | Customer's order history as "✅ Ordered" |

There is no manual status control in the admin panel any more — delivery to
WhatsApp *is* the status transition.

---

## Automatic cleanup after 7 days

Every order is written with an `expireAt` timestamp 7 days in the future.
Firestore deletes the document once that time passes **provided a TTL policy is
enabled**:

1. Firebase console → **Firestore Database** → **Settings** → **TTL**
2. Enable TTL and set the field name to `expireAt`

Without the TTL policy the app still cleans up on its own:

- A customer's own history older than 7 days is deleted when they open
  *My Orders*.
- The admin panel sweeps the whole collection hourly via `purgeOrdersOlderThan(7)`
  (fails harmlessly if the rules don't permit sweeping other users' orders).

---

`Admin → 📲 WhatsApp Alerts` lets you:

- **See live connection status** (connected / waiting for scan / offline)
- **Scan the pairing QR** to link a device
- **Send a test message** to confirm delivery
- **Unlink the device** if the phone is lost or replaced
- **Grab a `wa.me` quick-chat QR** for `+9058767686`
- **Toggle auto-send** so orders stop/start flowing without code changes
- **Point at a different server URL** (e.g. `http://192.168.1.9:3000`) when the
  bridge runs on another machine

---

## Configuration

All optional — set as environment variables before `npm start`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `WA_OWNER_NUMBER` | `9058767686` | Number that receives orders (auto-normalised to `919058767686`) |
| `WA_SESSION_DIR` | `server/.wa-session` | Where auth keys are stored |
| `WA_API_KEY` | *(unset)* | If set, calls must send `x-api-key` |
| `WA_LOG_LEVEL` | `info` | pino log level |

### Phone numbers

`WA_OWNER_NUMBER` is normalised to full international form, because a bare
10-digit number is not a valid WhatsApp JID:

| You provide | WhatsApp JID used | Shown in the UI |
| --- | --- | --- |
| `9058767686` | `919058767686@s.whatsapp.net` | `+91 90587 67686` |
| `919058767686` | `919058767686@s.whatsapp.net` | `+91 90587 67686` |
| `+91 90587 67686` | `919058767686@s.whatsapp.net` | `+91 90587 67686` |

The same normalisation is applied to the customer's phone number when building
the `wa.me` link inside the order message.

---

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness probe |
| `GET` | `/api/whatsapp/status` | State + live QR as a data URL |
| `GET` | `/api/whatsapp/qr.png` | Pairing QR as PNG |
| `GET` | `/api/whatsapp/chat-link` | `wa.me` deep link to the owner |
| `GET` | `/api/whatsapp/qr-chat.png` | `wa.me` link as PNG |
| `POST` | `/api/whatsapp/test` | Send a sample message |
| `POST` | `/api/whatsapp/send-order` | Send a real order |
| `POST` | `/api/whatsapp/preview` | Render a message **without sending** |
| `POST` | `/api/whatsapp/logout` | Unlink the device |

Example:

```bash
curl -X POST http://localhost:3000/api/whatsapp/send-order \
  -H 'Content-Type: application/json' \
  -d '{"order":{"id":"abc123","userName":"Rahul","userPhone":"9876543210",
       "subtotal":847,"deliveryCharge":25,"total":872,
       "lat":22.3569,"lng":73.1812,"address":"Ahmedabad",
       "items":[{"name":"Biryani","qty":2,"price":299}]}}'
```

Use `/api/whatsapp/preview` to inspect the exact message without sending it.

---

## Commands

```bash
npm start       # run the bridge
npm run dev     # run with auto-reload
npm run serve   # serve the site on http://localhost:8080
npm run validate  # check index.html JSX still compiles
npm test        # exercise the order pipeline against a running server
npm run test:numbers    # phone normalisation unit tests (no server needed)
npm run test:dispatch   # order -> WhatsApp state machine (no server needed)
```

> ⚠️ **`npm test` never sends a real WhatsApp message.** Once the device is
> linked, `/send-order` would text a real phone number, so the test skips it by
> default. To opt in deliberately:
>
> ```bash
> ALLOW_REAL_SEND=1 npm test      # Windows (Git Bash): ALLOW_REAL_SEND=1 npm test
> ```

---

## ⚠️ Security notes

- **`server/.wa-session/` is git-ignored and must stay that way.** It holds your
  WhatsApp auth keys — anyone who copies them can control the linked account.
- **The bridge has no authentication by default.** It is meant for
  `localhost`. If you expose it to a network or the internet, set
  `WA_API_KEY` and put it behind a reverse proxy with TLS. The admin panel can
  send the key — keep it out of the public `index.html` if the site is static
  and public.
- **A linked WhatsApp session can get the number banned** if the account sends
  bulk unsolicited messages. This sends to your own number only — don't
  repoint `WA_OWNER_NUMBER` at customers.
- **This is not an official WhatsApp Business API.** Baileys drives a normal
  WhatsApp account through the web protocol. For official, policy-compliant
  messaging at scale, migrate to the WhatsApp Business Cloud API.