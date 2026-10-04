# Shayona Cafe – Kitchen Display System (KDS)

This replaces the printed dockets. Square orders (walk-in and online) appear on screens in the kitchen. Staff tap items off as they're made, the window finishes and boxes them, and the front counter marks them collected. Every tap is timed, so reports show how long each order, item and station takes.

---

## 1. How an order flows

```
Square POS / Square Online
        │  (webhook, instant)
        ▼
  Supabase (database + live updates)
        │
        ├──► Station screens (5)   show ONLY their own items   → tap = item made
        ├──► Order handling window shows whole orders          → tap = finished / boxed
        ├──► Front counter         shows every order by status → tap = collected
        └──► Pickup board (TV)     Preparing / Ready numbers (no buttons)
```

| Screen | Sees | Taps |
|---|---|---|
| **Station** (e.g. Pizza) | Only items routed to that station, with timer, qty, modifiers, BOX/PLATE | Tap an item = 1 unit done (3 pizzas = 3 taps, or **ALL**). **DONE ✓** = whole order for that station |
| **Window** | Whole orders. Items still in the kitchen are shown faded ("Waiting · Pizza 1/3 made"); made items turn green | Tap a green item to finish it. **FINISH ORDER ✓** appears when everything is made. **⋮** = force-finish if a station forgot to tap |
| **Front counter** | Every open order in 3 columns: In kitchen · At window · Ready to collect | **COLLECTED ✓** (or tap single items for part pick-up). **⋮** = force-complete |
| **Pickup board** | Order numbers only | none (customer-facing TV) |

All screens include:

- **Timers** on every order: green, then amber after 5 min, then red and pulsing after 10 min. You can change the times overall or per station.
- **Online orders**: purple stripe and an **ONLINE** badge, plus the customer name and pickup time.
- **BOX / PLATE badge** on every food item. It comes from the "Take Away" modifier your Square menu already has.
- **New-order chime**, with a different chime for online orders.
- **UNDO** after every tap, and **↺ Recall** to bring back anything bumped in the last 2 hours.
- **Layouts** (⚙): Tickets, Docket rail, List, Item summary (all-day totals per item, good for pizza), card size, text size, sorting, dark/light, all-day count sidebar. Each tablet remembers its own settings.
- **86 button**: switch items on or off. The change goes to Square too (see section 6).
- **Cancelled in Square**: the ticket turns red with a strike-through, so the kitchen stops making it.

---

## 2. What's in this folder

```
kds/
├── web/                         ← the screens (static website → Vercel)
│   ├── index.html, styles.css, config.js, vercel.json
│   └── js/  app.js  screens.js  pages.js  api.js  demo-menu.js
├── supabase/
│   ├── migrations/001_kds_schema.sql              ← run once in Supabase SQL editor
│   ├── migrations/002_optional_safety_net_cron.sql
│   └── functions/
│       ├── square-webhook/       ← receives orders from Square
│       ├── square-sync/          ← menu sync, "pull missed orders", connection test
│       ├── square-availability/  ← item on/off → Square
│       └── _shared/square.ts
└── tests/                        ← the checks I ran (SQL flow test, order-format test, UI test)
```

Leave `web/config.js` empty to run in **demo mode**. Demo mode uses sample orders built from your real menu, and nothing is sent to Square.

---

## 3. One-time setup (about 45 minutes)

### Step A – Supabase project
1. Go to supabase.com → **New project** (e.g. `shayona-kds`, region **Sydney**).
2. **SQL Editor → New query**. Paste all of `supabase/migrations/001_kds_schema.sql` and click **Run**.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up".

### Step B – Logins
1. **Authentication → Users → Add user**. Create:
   - `kitchen@…` (one shared login for all kitchen tablets and TVs)
   - your own admin email
2. In the SQL Editor, make yourself admin:
   ```sql
   update profiles set role = 'admin'
   where user_id = (select id from auth.users where email = 'YOUR-ADMIN-EMAIL');
   ```
   Admins see Admin and Reports. Kitchen logins see the screens and Availability.

### Step C – Square developer app
1. Go to **developer.squareup.com** → sign in with the Shayona Square account → **Create app** ("Shayona KDS").
2. Switch to **Production** and copy the **Access token** (Credentials page).
3. Go to **Webhooks → Subscriptions → Add subscription** (Production):
   - URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/square-webhook`
   - Events: `order.created`, `order.updated`, `order.fulfillment.updated`, `catalog.version.updated`, `inventory.count.updated`
   - Save, then copy the **Signature key**.

### Step D – Deploy the 3 Square functions
On any computer with Node installed, open a terminal in the `kds` folder:
```bash
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF

npx supabase secrets set \
  SQUARE_ACCESS_TOKEN="EAAA…" \
  SQUARE_WEBHOOK_SIGNATURE_KEY="…" \
  SQUARE_WEBHOOK_URL="https://YOUR-PROJECT-REF.supabase.co/functions/v1/square-webhook" \
  CRON_SECRET="make-up-a-long-random-word"

npx supabase functions deploy square-webhook --no-verify-jwt
npx supabase functions deploy square-sync
npx supabase functions deploy square-availability
```
`SQUARE_WEBHOOK_URL` must match the webhook URL in Square **exactly**, or orders are rejected.

### Step E – Put the screens online (Vercel, same as the Stock Control Portal)
1. Edit `web/config.js` and add your **Project URL** and **anon public key** (Supabase → Settings → API).
2. Push the `kds` folder to a new GitHub repo.
3. On Vercel, click **Add New → Project**, import the repo, set **Root Directory = `web`** and Framework = **Other**, then click Deploy.
4. Optional: add a domain such as `kds.shayona.com.au`.

### Step F – First run (Admin screen)
1. Sign in with your admin email. Go to **Admin → Square & data**.
   - **Test connection**. It should say "Shayona Cafe".
   - **Sync menu from Square**. This loads every café item and category.
2. Go to **Admin → Stations** and create your 5 stations (name, colour, timer limits).
3. Go to **Admin → Item routing**:
   - Pick a station for each **category**, or choose "No prep → straight to Window" (e.g. Bakery cabinet, packaged sweets).
   - Override single items where needed (e.g. bottled drinks = No prep, lassi = Drinks station).
   - Categories with no station show a red edge. Items with no station still appear on the Window, marked "No station set", so nothing is ever lost.
4. Optional: run `002_optional_safety_net_cron.sql`. It re-checks Square every 2 minutes in case the internet drops.

### Step G – Tablets and TVs
1. Go to **Admin → Screen links**. Open each link on its tablet or TV and sign in with the kitchen login.
2. Tap **Start screen**. This turns on the chime and keeps the screen awake. Then use **Add to Home Screen**.
3. Use **⚙** to choose the layout for that spot.

### Step H – Test
Ring up a test order in Square POS with a pizza ×3 (one with the Take Away modifier) and a drink. Within a few seconds it should appear on the Pizza and Drinks stations. Tap through station → window → front, then refund the test sale.

---

## 4. Running cost
- **Supabase free plan**: fine for one café. Free projects pause only after a week with no use, which won't happen with daily trading. Upgrade to Pro (≈US$25/m) later if you want daily backups.
- **Vercel Hobby**: free.
- No per-device fees. You can add as many tablets and TVs as you like.

---

## 5. Daily use (for staff)
- **Station:** make the item and tap it. For multiple quantities, tap once per unit, or **ALL**. When everything on the ticket is done, tap **DONE ✓**. Tapped the wrong one? Press **UNDO**, or **↺ Recall**.
- **Window:** green items are ready to cut or box. Check the **BOX/PLATE** badge. When the card turns green, tap **FINISH ORDER ✓**. Then call the number.
- **Front:** when the customer collects, tap **COLLECTED ✓**.
- **Item runs out:** tap **86** and switch it off. Square POS and online then show it as sold out. Switch it back on when it's available again.
- **End of day:** an admin presses **Admin → Square & data → Close all open orders** to clear anything left on the screens. Those orders are marked "forced" and kept out of the time averages.

---

## 6. Things to know
- **Order number** = the number Square prints on the docket (`ticket_name`, e.g. 35). I checked this against today's real café orders. If an order has no number (some online orders), the KDS gives it the next daily number.
- **Online orders** are detected from the Square order source (Square Online, Uber, DoorDash, Menulog… editable in Settings). Walk-ins come in as "Point of Sale".
- **Box or plate:** a "Take Away" modifier gives **BOX**. No modifier gives **PLATE** for walk-ins and **BOX** for online orders. You can change the words and defaults in Settings. Drinks don't show the PLATE badge.
- **Item on/off and Square:** Square doesn't allow outside apps to tick the "Sold out" box. So **off** sets the item's stock at the café to 0, which Square shows as **Sold out** on POS and Square Online. **On** puts back the previous stock count, or 999 if you weren't tracking stock, and switches stock tracking back off if it wasn't on before. If you'd rather hide the item completely, change "Availability switch" in Settings to "Hide item".
- **Reports** (Admin): Summary, By station, By item, By order and By hour, for any date range. You can filter by station, item and walk-in/online, and download each one as CSV.
- **Dine-in later:** orders already store a dining mode and a table, and Square open tickets with table names come through. Table and floor screens can be added on top of this without changing the kitchen screens.

## 7. Troubleshooting
| Problem | Fix |
|---|---|
| No orders appearing | Admin → Square & data → **Test connection**. In Supabase → Edge Functions → square-webhook → Logs, "bad signature" means `SQUARE_WEBHOOK_URL` or the signature key doesn't match Square. |
| Red dot / "Connection lost" banner | The tablet's Wi-Fi dropped. The screen catches up by itself within 20 s of reconnecting. |
| Item went to the wrong station | Admin → Item routing. The change applies to new orders. |
| An item shows "No station set" on the Window | That category or item isn't routed yet. Fix it in Item routing. |
| Availability switch shows an error | The Square token needs Inventory and Catalog permissions (a personal Production access token has them). |
