# Update 2: Make line, part-order pickup, and Menu Manager merged into the KDS

## What's new
- **Window "Make line" view.** This is now the window's default layout; the ticket views are still available under ⚙ → Layout. The screen shows only the items that are ready to dress, grouped by item with the oldest order first. Each unit has its own row showing the order number, BOX/PLATE and modifiers. Tap a row when that item is dressed.
  - A **LAST ITEM** flag appears when finishing that unit completes the order.
  - The "coming" count shows what's still being cooked.
  - ⚙ → "Group identical" merges same-pack, same-modifier units into one tap.
- **Part-order pickup.**
  - **Front counter** has three columns: In kitchen · **Collect now (part ready)** · All ready. Cards show "2 of 3 ready/collected" and "Still to come: …". **Hand over ready** collects just the ready items.
  - **Pickup board** has three columns: Preparing · **Collect now** (shows "1 of 3") · All ready.
  - **Hold until order complete** (Admin → Item routing): mark categories or items (e.g. ice cream, hot drinks) to stay at the counter until the rest of the order is ready.
- **Menu control** replaces the local Menu Manager.
  - Item availability, NEW badge, (J) Jain mark, ⏱ wait times, add-on lines and board category.
  - Presets, board header and screen notices (Break / Aarti / Closed / Custom).
  - Photos and videos for the slideshow.
  - **Automatic wait times** on the TV menu, calculated from how long the kitchen is actually taking.
- **TV menu board and slideshow** keep your existing design and now run from the KDS website: `…/menu-board.html` and `…/menu-slideshow.html`. They need no login and no computer running in the café.

## Install (about 20 minutes)

### 1. Supabase: database
In **SQL Editor**, paste all of **`003_menu_and_pickup.sql`** and click **Run**.

Then run **`006_stock_on_hand.sql`** the same way. It makes Menu control and the TV screens list only items with a café stock count of 0 or more in Square.

### 2. Supabase: replace the 3 functions
The new code makes item on/off much faster for presets, and the menu sync now brings in prices and descriptions.

In **Edge Functions**, open each function → **Code**, replace everything with the matching file from `dashboard-paste`, then click **Deploy**:
- `square-webhook` (keep "Verify JWT" off)
- `square-sync`
- `square-availability`

### 3. GitHub: website files
Upload everything in `web-update.zip` into your repo, replacing the old files. **Keep your own `config.js`**; it isn't in the zip.

New files: `menu-board.html`, `menu-slideshow.html`, `js/pages-menu.js`, `js/menu-feed.js`.

### 4. Bring your menu across
1. In the KDS, go to **Admin → Square & data → Sync menu from Square**. This loads prices and descriptions.
2. Back in Supabase **SQL Editor**, run **`004_import_menu_manager_data.sql`**. It copies your 16 Jain marks, NEW badge, 3 add-on lines and the "Weekend Menu" preset.
3. Go to **Menu control → Photos & videos** and upload your dish photos (`Vada Pav.png`, `Grilled Panini Sandwich.png`) and promos (`Ice Creame Scoop.mp4`, `Kathi Roll.mp4`) from the old `public/menu-images` and `public/promos` folders.

### 5. Switch the TVs over
Open `https://YOUR-SITE/menu-board.html` and `https://YOUR-SITE/menu-slideshow.html` on the TVs and press F11 for full screen. Then **stop using the old Menu Manager**, so two systems aren't switching items on and off.

### 6. Optional
Go to **Admin → Item routing** and tick **Hold** for categories like Dessert or Hot Beverages if you don't want them handed out before the rest of the order.
