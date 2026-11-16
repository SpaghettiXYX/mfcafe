# MFCafe E-Portal

Point-of-sale and ordering portal for **MFCafe**, the student-run café of a school in Hong Kong SAR.

> **This is a live production system, not a demo.** The deployed pages are used by real
> staff and customers during service hours — do not edit the site directly unless you
> intend to change the running shop. Test changes on a branch first.

---

## Entry points

| Page | What it does |
| --- | --- |
| `index.html` | Staff portal — Cashier POS, Bar KDS, Pickup Screen, Clearing, Count Money and the Admin Panel |
| `customer.html` | Student / teacher self-order (menu, options, note, review, submit) |
| `self-service.html` | Order status check by order number |
| `openday.html` | Open Day ordering flow |
| `bulky.html` | Bulk / large orders |
| `poster.html` | Full-screen poster carousel for the in-store TV (`assets/posters/manifest.json`) |
| `qrgen.html` | QR tile generator used for the POS table tiles |
| `cropper.html` | Utility that crops product photos to 1:1 before uploading them to `assets/` |

Public URL: <https://spaghettixyx.github.io/mfcafe/>

---

## Architecture

```
Browser (static HTML)  ──POST {action, ...}──▶  Google Apps Script (Code.gs)
        │                                              │
        └── GitHub Pages (branch: main, root)           └── Google Sheets (menu, orders, users, settings)
```

* **Front end** — plain single-file HTML with vanilla JavaScript. Tailwind CSS, Font Awesome,
  html5-qrcode and qrcodejs are loaded from CDNs. There is **no build step and no bundler**;
  what is committed is what is served.
* **Back end** — one Google Apps Script Web App (`Code.gs`, `appsscript.json`) that receives
  JSON requests with an `action` field and answers with JSON. Sheets are the database;
  script properties hold settings (pauses, announcements, hotkeys, categories, colors…).
* **Images** — product photos live in `assets/` (or any public URL) and are referenced by the
  item's `imageUrl` field, which is editable in Admin › Menu.
* **State** — the logged-in staff member is kept in a cookie plus `localStorage`; the theme
  and the sidebar preference are also remembered per device.

### Backend configuration

Every page talks to the deployment URL stored in its own `APPS_SCRIPT_URL` constant:

```js
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycb.../exec";
```

When you redeploy the Apps Script project, update this constant in **all** pages
(`index.html`, `customer.html`, `self-service.html`, `openday.html`, `bulky.html`, `poster.html`).

---

## Staff portal views

* **Cashier POS** — menu by category, size / temperature / notes, discounts and promo codes,
  QR tile handling (snack items skip the tile, drinks require one), order submission and receipt.
* **Bar KDS** — live ticket board with unassigned-order alerts, assignment, ready / print flow.
* **Pickup Screen** — customer-facing display that only lists **READY** orders; supports
  fullscreen display mode and QR scan-to-clear.
* **Clearing** — swipe / scan to clear collected drinks.
* **Count Money** — end-of-day cash counting by note and coin denomination.
* **Admin Panel** — dashboard KPIs plus menu, categories, QR tiles, users and staff cards,
  promotions, posters, announcements, KDS status strip, receipt layout, printer, opening hours,
  manual/instructions content and financial history.

### Roles

* **Staff** — logs in with a staff code or username/password; optional Google sign-in when configured.
* **Admin** — sees the Admin Panel; a per-user `canPrint` flag controls ticket printing.

---

## Repository layout

```
index.html            staff portal (POS / KDS / pickup / clearing / money / admin)
customer.html         self-order page
self-service.html     order status lookup
openday.html          open-day ordering
bulky.html            bulk ordering
poster.html           TV poster carousel
qrgen.html            QR tile generator
cropper.html          1:1 photo cropper
self-order-history.js shared customer-side helper
Code.gs               Google Apps Script backend
appsscript.json       Apps Script manifest
chime.mp3             kitchen alert sound
assets/               logo, product photos, poster manifest
lakala/               LAKALA hardware projects (see below)
  usb-poster/         USB poster flasher
  p4-offline/         CS80 offline poster firmware
  p4-led-test/        panel / LED bring-up test
  pcb-lakala-v103/    V103 PCB fabrication files
```

### LAKALA hardware projects

| Folder | Contents |
| --- | --- |
| `lakala/usb-poster/` | USB flasher + `firmware/lakala.bin` for turning the LAKALA customer display into a poster screen |
| `lakala/p4-offline/` | Offline poster firmware for the LAKALA CS80 customer display (Raspberry Pi pushes JPEG frames) |
| `lakala/p4-led-test/` | LED / panel bring-up test, wiring derived from the LAKALA_V103 netlist |
| `lakala/pcb-lakala-v103/` | LAKALA V103 PCB — Gerber archive, BOM and pick-and-place files |

---

## Deploying

1. **Front end** — merge to `main`; GitHub Pages serves the repository root on the next build.
   Commit IDs are visible in the Pages build history, so a rebuild can be verified in seconds.
2. **Back end** — paste the current `Code.gs` into the Apps Script project, then
   *Deploy › Manage deployments › Edit › Version: New version › Deploy*.
   Editing an existing deployment keeps the URL unchanged.
3. **Verification** — open the portal, sign in, and check that the menu loads. If a page shows
   `Cannot reach the server`, the deployment URL is stale or the Web App is not accessible to
   "Anyone".

### Notes

* GitHub Pages caches HTML for about 10 minutes — hard-refresh (`Ctrl/Cmd + Shift + R`) after a deploy.
* Orders are one drink per submission on the self-order page; the POS is likewise a single-item flow.
* The pickup screen intentionally never shows *preparing* orders — only **READY**.

---

## License

MIT — see [LICENSE](LICENSE).
