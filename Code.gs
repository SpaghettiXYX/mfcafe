/**
 * BLMCSS CAFE - Backend Core Script (Code.gs)
 * Features: Menu Categories, QR Tile System, Smart Loading
 */

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getVersion() {
  const props = PropertiesService.getScriptProperties();
  let ver = props.getProperty("STATE_VERSION");
  if (!ver) { ver = String(Date.now()); props.setProperty("STATE_VERSION", ver); }
  return ver;
}

function bumpVersion() {
  const ver = String(Date.now());
  PropertiesService.getScriptProperties().setProperty("STATE_VERSION", ver);
  return ver;
}

// ==================== HARDWARE INTEGRATION (SJ-P3-B Thermal Label Printer) ====================
// Reserved hook points for future hardware bridge integration.
//
// Target hardware: SJ-P3-B (昇界科技) — Bluetooth / Wi-Fi thermal label printer
// Print volume: 58mm label paper
// Bridge: Raspberry Pi + Node.js bridge subscribing via MQTT / HTTP webhook
//
// WHEN TO PRINK:
//   - placeOrder() → after row appended → call emitPrintEvent(order, "kitchen")
//   - updateOrderStatus("READY") → call emitPrintEvent(order, "label")
//   - clearOrderByTile() → call emitPickupNotify(order)
//
// emitPrintEvent(order, "label")  → Pi bridge → ESC/POS → SJ-P3-B
// emitPrintEvent(order, "kitchen") → Pi bridge → thermal kitchen ticket
//
// Implementation is intentionally deferred — deploy SJ-P3-B + Pi first,
// then wire up UrlFetchApp / MQTT in these functions.

function emitPrintEvent(order, printType) {
  // printType: "label" (cup sticker for pickup) | "kitchen" (food prep ticket)
  //
  // DEFERRED IMPLEMENTATION — coming soon with SJ-P3-B hardware
  //
  // Bridge URL (Pi local HTTP endpoint, change after Pi setup):
  //   const BRIDGE_URL = "http://mfcafe-pi.local:8080/print";
  //
  //   try {
  //     UrlFetchApp.fetch(BRIDGE_URL, {
  //       method: "POST",
  //       contentType: "application/json",
  //       payload: JSON.stringify({
  //         type: printType,          // "label" | "kitchen"
  //         order: order,             // full order object with cupType
  //         categoryColor: getCategoryColors()[order.category || "Other"] || "#64748b",
  //         timestamp: Date.now()
  //       }),
  //       muteHttpExceptions: true,
  //       timeout: 3000
  //     });
  //   } catch (e) { /* bridge offline — non-fatal, log only */ }
  //
  // For now this function is a no-op so the system keeps working
  // without the Pi. It will activate once the hardware is deployed.
}

function emitPickupNotify(order) {
  // Pi pickup display "ORDER X001 READY — Tile 5"
  // DEFERRED — coming soon with Pi hardware
}

// ==================== CATEGORIES ====================
function getCategories() {
  const props = PropertiesService.getScriptProperties();
  let cats = props.getProperty("MENU_CATEGORIES");
  if (!cats) {
    cats = "Hot Drinks,Cold Drinks,Snacks,Other";
    props.setProperty("MENU_CATEGORIES", cats);
  }
  return cats.split(",").map(s => s.trim()).filter(Boolean);
}

function saveCategories(catsStr) {
  PropertiesService.getScriptProperties().setProperty("MENU_CATEGORIES", catsStr);
  bumpVersion();
  return { success: true, categories: catsStr.split(",").map(s => s.trim()).filter(Boolean) };
}

// Category colors: stored as JSON { "Hot Drinks": "#f97316", ... }
function getCategoryColors() {
  const raw = PropertiesService.getScriptProperties().getProperty("MENU_CATEGORY_COLORS");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function saveCategoryColor(category, color) {
  const name = String(category || "").trim();
  if (!name) return { success: false, error: "Category name is required" };
  const hex = String(color || "").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return { success: false, error: "Invalid color (expected #RRGGBB)" };
  const colors = getCategoryColors();
  colors[name] = hex;
  PropertiesService.getScriptProperties().setProperty("MENU_CATEGORY_COLORS", JSON.stringify(colors));
  bumpVersion();
  return { success: true, categoryColors: colors };
}

// ==================== SHEET HELPERS ====================
function ensureUsersSheet(ss) {
  let usersSheet = ss.getSheetByName("Users");
  if (!usersSheet) {
    usersSheet = ss.insertSheet("Users");
    usersSheet.appendRow(["Username", "Password", "Role", "UserCode", "CanPrint", "GoogleEmail", "StaffCard"]);
    usersSheet.appendRow(["spaghetti", "123456", "Staff", "1", "FALSE", "", ""]);
    usersSheet.appendRow(["tl.li", "123456", "Admin", "2", "TRUE", "", ""]);
    usersSheet.appendRow(["ky.wong", "123456", "Admin", "3", "TRUE", "", ""]);
    usersSheet.appendRow(["ku", "123456", "Staff", "4", "FALSE", "", ""]);
  } else {
    const headers = usersSheet.getRange(1, 1, 1, 7).getValues()[0];
    if (!headers[2] || String(headers[2]).trim() === "") usersSheet.getRange(1, 3).setValue("Role");
    if (!headers[3] || String(headers[3]).trim() === "") usersSheet.getRange(1, 4).setValue("UserCode");
    // CanPrint column (col 5) — auto-grant Admins, deny Staff by default
    if (!headers[4] || String(headers[4]).trim() === "") {
      usersSheet.getRange(1, 5).setValue("CanPrint");
      const data = usersSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const role = String(data[i][2] || "Staff").trim().toLowerCase();
        const existing = String(data[i][4] || "").trim();
        if (!existing) usersSheet.getRange(i + 1, 5).setValue(role === "admin" ? "TRUE" : "FALSE");
      }
    }
    // GoogleEmail column (col 6) — link a Google account for one-tap login
    if (!headers[5] || String(headers[5]).trim() === "") {
      usersSheet.getRange(1, 6).setValue("GoogleEmail");
    }
    // StaffCard column (col 7) — the string printed on the school-issued staff card.
    // Deliberately separate from UserCode, which is the numeric order-number prefix.
    if (!headers[6] || String(headers[6]).trim() === "") {
      usersSheet.getRange(1, 7).setValue("StaffCard");
    }
  }
  return usersSheet;
}

function ensureOrdersSheet(ss) {
  let sheet = ss.getSheetByName("Orders Log");
  if (!sheet) {
    sheet = ss.insertSheet("Orders Log");
    sheet.appendRow([
      "OrderNum", "OrderTime", "PickupTime", "Cashier", "GuestName",
      "ProductName", "Temp", "Customization", "Price", "Status", "QRTile", "PaymentStatus",
      "CupType",  // "In-Store" or "Takeaway"
      "Discount", // amount off the whole order
      "PromoCode", // promo code applied at checkout, if any
      "DiscountBy" // staff member who authorised a manual discount
    ]);
  } else {
    const headers = sheet.getRange(1, 1, 1, 16).getValues()[0];
    if (!headers[11] || String(headers[11]).trim() === "") {
      sheet.getRange(1, 12).setValue("PaymentStatus");
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const status = String(data[i][9] || "").trim().toUpperCase();
        const paymentStatus = (status === "UNPAID" || status === "RESERVED") ? "UNPAID" : "PAID";
        sheet.getRange(i + 1, 12).setValue(paymentStatus);
      }
    }
    // CupType column (col 13) — backfill existing rows with "In-Store" as default
    if (!headers[12] || String(headers[12]).trim() === "") {
      sheet.getRange(1, 13).setValue("CupType");
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const existing = String(data[i][12] || "").trim();
        if (!existing) sheet.getRange(i + 1, 13).setValue("In-Store");
      }
    }
    // Discount / PromoCode / DiscountBy columns (14-16) — promotions feature.
    if (!headers[13] || String(headers[13]).trim() === "") sheet.getRange(1, 14).setValue("Discount");
    if (!headers[14] || String(headers[14]).trim() === "") sheet.getRange(1, 15).setValue("PromoCode");
    if (!headers[15] || String(headers[15]).trim() === "") sheet.getRange(1, 16).setValue("DiscountBy");
  }
  // Force OrderNum column (A) to plain text so Sheets never silently
  // reinterprets values like "1035" or "1035-1" as dates and breaks KDS.
  const lastRow = sheet.getMaxRows();
  if (lastRow > 0) {
    sheet.getRange(1, 1, lastRow, 1).setNumberFormat("@");
    // One-time migration: any row whose OrderNum cell became a Date during
    // a buggy write is rewritten back as text so the counter and KDS stay sane.
    const allValues = sheet.getRange(1, 1, lastRow, 1).getValues();
    let dirty = false;
    for (let r = 1; r < allValues.length; r++) {
      const v = allValues[r][0];
      if (v instanceof Date) {
        sheet.getRange(r + 1, 1).setValue("");
        dirty = true;
      } else if (v !== "" && !/^\d+(-\d+)?$/.test(String(v).trim())) {
        sheet.getRange(r + 1, 1).setValue("");
        dirty = true;
      }
    }
    if (dirty) SpreadsheetApp.flush();
  }
  return sheet;
}

function ensureQRTilesSheet(ss) {
  let sheet = ss.getSheetByName("QR Tiles");
  if (!sheet) {
    sheet = ss.insertSheet("QR Tiles");
    sheet.appendRow(["TileCode", "Status", "BoundOrder"]);
    // Pre-create 30 tiles (1-30)
    for (let i = 1; i <= 30; i++) {
      sheet.appendRow([String(i), "Available", ""]);
    }
  } else {
    const headers = sheet.getRange(1, 1, 1, 3).getValues()[0];
    if (!headers[2] || String(headers[2]).trim() === "") {
      sheet.getRange(1, 3).setValue("BoundOrder");
    }
  }
  return sheet;
}

// Ensure menu sheet has Category (E) and ColdPaused (F) columns
function ensureMenuSheetColumns(sheet) {
  const headers = sheet.getRange(1, 1, 1, 10).getValues()[0];
  if (!headers[4] || String(headers[4]).trim() === "") {
    sheet.getRange(1, 5).setValue("Category");
  }
  if (!headers[5] || String(headers[5]).trim() === "") {
    sheet.getRange(1, 6).setValue("ColdPaused");
  }
  if (!headers[6] || String(headers[6]).trim() === "") {
    sheet.getRange(1, 7).setValue("ImageUrl");
  }
  if (!headers[7] || String(headers[7]).trim() === "") {
    sheet.getRange(1, 8).setValue("Description");
  }
  if (!headers[8] || String(headers[8]).trim() === "") {
    sheet.getRange(1, 9).setValue("AllowNotes");
  }
  if (!headers[9] || String(headers[9]).trim() === "") {
    sheet.getRange(1, 10).setValue("SoldOut");
  }
}

// ==================== AUTH ====================
function authenticateUser(username, password) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ensureUsersSheet(ss);
  const data = usersSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === String(username).trim().toLowerCase() &&
        String(data[i][1]).trim() === String(password).trim()) {
      return { success: true, username: String(data[i][0]).trim(), role: String(data[i][2] || "Staff").trim(), userCode: String(data[i][3] || "1").trim(), canPrint: String(data[i][4] || "").trim().toUpperCase() === "TRUE" };
    }
  }
  return { success: false, error: "Invalid username or password" };
}

// Staff-card login: a USB barcode scanner types the card's UserCode and then
// presses Enter. One card may be shared by several accounts, so the response
// always returns every matching account and the UI asks which one to use.
function authenticateByStaffCode(code) {
  const wanted = String(code || "").trim().toLowerCase();
  if (!wanted) return { success: false, error: "No staff card code received" };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ensureUsersSheet(ss);
  const data = usersSheet.getDataRange().getValues();
  const accounts = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    const card = String(data[i][6] || "").trim().toLowerCase();
    if (!card) continue;
    if (card === wanted) {
      accounts.push({
        username: String(data[i][0]).trim(),
        role: String(data[i][2] || "Staff").trim(),
        userCode: String(data[i][3] || "1").trim(),
        staffCard: String(data[i][6] || "").trim(),
        canPrint: String(data[i][4] || "").trim().toUpperCase() === "TRUE"
      });
    }
  }
  if (!accounts.length) return { success: false, error: "Staff card not recognised" };
  return Object.assign({ success: true, accounts: accounts }, accounts[0]);
}

// ==================== GOOGLE SIGN-IN ====================
// One-time setup (free):
//   1. console.cloud.google.com -> create a project
//   2. OAuth consent screen -> External -> fill app name + your email
//   3. Credentials -> Create OAuth Client ID -> Web application
//      Authorized JavaScript origins: https://<your-github-pages-host>
//   4. In the Apps Script editor run:  setGoogleClientId("xxxx.apps.googleusercontent.com")
// The client ID is public by design; security comes from verifying the token
// audience server-side and matching the email against the Users sheet.
function setGoogleClientId(id) {
  PropertiesService.getScriptProperties().setProperty("GOOGLE_CLIENT_ID", String(id || "").trim());
  return { success: true, googleClientId: String(id || "").trim() };
}

function authenticateGoogle(credential) {
  const clientId = PropertiesService.getScriptProperties().getProperty("GOOGLE_CLIENT_ID");
  if (!clientId) return { success: false, error: "Google login is not configured yet" };
  if (!credential) return { success: false, error: "Missing Google credential" };
  let info;
  try {
    const resp = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential),
      { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return { success: false, error: "Google token verification failed" };
    info = JSON.parse(resp.getContentText());
  } catch (err) {
    const msg = String((err && err.message) || err || "");
    if (/permission|scope|external_request|UrlFetchApp/i.test(msg)) {
      return { success: false, error: "Apps Script lacks the external-request permission. Open appsscript.json in the editor, keep the script.external_request scope, run any function once to approve access, then deploy a new version." };
    }
    return { success: false, error: "Google token verification failed" };
  }
  if (String(info.aud || "") !== clientId) return { success: false, error: "Google token audience mismatch" };
  if (String(info.email_verified || "") !== "true") return { success: false, error: "Google email is not verified" };
  const email = String(info.email || "").trim().toLowerCase();
  if (!email) return { success: false, error: "Google account has no email" };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ensureUsersSheet(ss);
  const data = usersSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const linked = String(data[i][5] || "").trim().toLowerCase();   // col F GoogleEmail
    const uname = String(data[i][0] || "").trim();
    const unameAsEmail = uname.indexOf("@") >= 0 ? uname.toLowerCase() : "";
    if ((linked && linked === email) || (unameAsEmail && unameAsEmail === email)) {
      return { success: true, username: uname, role: String(data[i][2] || "Staff").trim(), userCode: String(data[i][3] || "1").trim(), canPrint: String(data[i][4] || "").trim().toUpperCase() === "TRUE" };
    }
  }
  return { success: false, error: "Google account not linked — ask Admin to link it in Admin Panel → Users (no sign-up via Google)" };
}

function addUser(username, password, role, userCode, staffCard) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ensureUsersSheet(ss);
  const canPrint = (role || "Staff").toLowerCase() === "Admin" ? "TRUE" : "FALSE";
  usersSheet.appendRow([username, password, role || "Staff", userCode || "1", canPrint, "", String(staffCard || "").trim()]);
  bumpVersion();
  return { success: true };
}

function setUserCanPrint(username, canPrint) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ensureUsersSheet(ss);
  const data = usersSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === String(username).trim().toLowerCase()) {
      usersSheet.getRange(i + 1, 5).setValue(canPrint ? "TRUE" : "FALSE");
      bumpVersion();
      return { success: true };
    }
  }
  return { success: false, error: "User not found" };
}

function setUserStaffCard(username, staffCard) {
  const card = String(staffCard || "").trim();
  if (!card) return { success: false, error: "Staff card code is required" };
  if (card.length > 64) return { success: false, error: "Staff card code is too long" };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ensureUsersSheet(ss);
  const data = usersSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === String(username).trim().toLowerCase()) {
      usersSheet.getRange(i + 1, 7).setValue(card);
      bumpVersion();
      return { success: true, username: String(data[i][0]).trim(), staffCard: card };
    }
  }
  return { success: false, error: "User not found" };
}

function deleteUser(username) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ensureUsersSheet(ss);
  const data = usersSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === String(username).trim().toLowerCase()) {
      usersSheet.deleteRow(i + 1);
      bumpVersion();
      return { success: true };
    }
  }
  return { success: false, error: "User not found" };
}

function changeUserPassword(username, password) {
  const pwd = String(password || "").trim();
  if (pwd.length < 4) return { success: false, error: "Password must be at least 4 characters" };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ensureUsersSheet(ss);
  const data = usersSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === String(username).trim().toLowerCase()) {
      usersSheet.getRange(i + 1, 2).setValue(pwd);
      bumpVersion();
      return { success: true };
    }
  }
  return { success: false, error: "User not found" };
}

// email "" = unlink the Google account. Sign-in only ever matches a linked
// email — there is no self-registration via Google.
function setUserGoogleEmail(username, email) {
  const val = String(email || "").trim();
  if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
    return { success: false, error: "Invalid email format" };
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ensureUsersSheet(ss);
  const data = usersSheet.getDataRange().getValues();
  let targetRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === String(username).trim().toLowerCase()) targetRow = i + 1;
    else if (val && String(data[i][5] || "").trim().toLowerCase() === val.toLowerCase()) {
      return { success: false, error: "That Google account is already linked to '" + String(data[i][0]).trim() + "'" };
    }
  }
  if (targetRow < 0) return { success: false, error: "User not found" };
  usersSheet.getRange(targetRow, 6).setValue(val);
  bumpVersion();
  return { success: true, googleEmail: val };
}

function saveHotkeys(hotkeysStr) {
  PropertiesService.getScriptProperties().setProperty("REMARK_HOTKEYS", hotkeysStr);
  bumpVersion();
  return { success: true };
}

// ==================== GLOBAL SETTINGS ====================
function getColdExtra() {
  const v = PropertiesService.getScriptProperties().getProperty("COLD_EXTRA");
  return v ? Number(v) : 2;
}

function setColdExtra(value) {
  const num = Number(value);
  if (isNaN(num) || num < 0) return { success: false, error: "Invalid cold extra price" };
  PropertiesService.getScriptProperties().setProperty("COLD_EXTRA", String(num));
  bumpVersion();
  return { success: true, coldExtra: num };
}

function getColdPaused() {
  return PropertiesService.getScriptProperties().getProperty("COLD_PAUSED") === "true";
}

function setColdPaused(paused) {
  PropertiesService.getScriptProperties().setProperty("COLD_PAUSED", paused ? "true" : "false");
  bumpVersion();
  return { success: true, coldPaused: paused };
}

// Teacher pre-order switch
function getTeacherReservationOpen() {
  const v = PropertiesService.getScriptProperties().getProperty("TEACHER_RESERVATION_OPEN");
  return v === null ? true : v === "true";
}

function setTeacherReservationOpen(open) {
  PropertiesService.getScriptProperties().setProperty("TEACHER_RESERVATION_OPEN", open ? "true" : "false");
  bumpVersion();
  return { success: true, teacherReservationOpen: open };
}

// Open Day pre-order switch
function getOpenDayReservationOpen() {
  const v = PropertiesService.getScriptProperties().getProperty("OPENDAY_RESERVATION_OPEN");
  return v === null ? true : v === "true";
}

function setOpenDayReservationOpen(open) {
  PropertiesService.getScriptProperties().setProperty("OPENDAY_RESERVATION_OPEN", open ? "true" : "false");
  bumpVersion();
  return { success: true, openDayReservationOpen: open };
}

// Bulky (multi-cup) pre-order switch
function getBulkyReservationOpen() {
  const v = PropertiesService.getScriptProperties().getProperty("BULKY_RESERVATION_OPEN");
  return v === null ? true : v === "true";
}

function setBulkyReservationOpen(open) {
  PropertiesService.getScriptProperties().setProperty("BULKY_RESERVATION_OPEN", open ? "true" : "false");
  bumpVersion();
  return { success: true, bulkyReservationOpen: open };
}

// Pause reason shown on customer/openday/bulky pages when ordering is paused
function getPauseReason(target) {
  const key = target === "teacher" ? "PAUSE_REASON_TEACHER" : target === "bulky" ? "PAUSE_REASON_BULKY" : "PAUSE_REASON_OPENDAY";
  const defaults = {
    teacher: "Online pre-order is temporarily paused. Please order at the counter.",
    openday: "Open Day pre-order is temporarily paused. Please order at the counter.",
    bulky: "Bulky (multi-cup) orders are temporarily paused. Please place smaller orders at the counter."
  };
  return PropertiesService.getScriptProperties().getProperty(key) || defaults[target] || defaults.teacher;
}

function setPauseReason(target, reason) {
  const key = target === "teacher" ? "PAUSE_REASON_TEACHER" : target === "bulky" ? "PAUSE_REASON_BULKY" : "PAUSE_REASON_OPENDAY";
  PropertiesService.getScriptProperties().setProperty(key, String(reason || ""));
  bumpVersion();
  return { success: true, target: target, reason: reason };
}

// Push message broadcast to all portal users
const PUSH_MESSAGE_TTL_MS = 48 * 60 * 60 * 1000; // 48h auto-expire

function getPushMessage() {
  const raw = PropertiesService.getScriptProperties().getProperty("PUSH_MESSAGE");
  if (!raw) return { active: false, text: "", sender: "", timestamp: 0 };
  try {
    const parsed = JSON.parse(raw);
    const ts = Number(parsed.timestamp) || 0;
    const age = Date.now() - ts;
    // Auto-expire stale push messages — prevents "ghost announcements" that
    // linger in PropertiesService after an admin forgot to click Clear.
    const actuallyActive = parsed.active === true
      && parsed.text
      && age < PUSH_MESSAGE_TTL_MS;
    return {
      active: actuallyActive,
      text: String(parsed.text || ""),
      sender: String(parsed.sender || ""),
      timestamp: ts
    };
  } catch (e) {
    return { active: false, text: "", sender: "", timestamp: 0 };
  }
}

function setPushMessage(text, sender, active) {
  const payload = {
    active: active === true,
    text: String(text || ""),
    sender: String(sender || ""),
    timestamp: Date.now()
  };
  PropertiesService.getScriptProperties().setProperty("PUSH_MESSAGE", JSON.stringify(payload));
  bumpVersion();
  return { success: true, pushMessage: payload };
}

// ==================== OPENING HOURS ====================
// Online pre-orders are limited to the café's opening hours. Admins can also
// define named pickup windows; the self-order pages show them as a dropdown.
const DEFAULT_OPENING_HOURS = {
  enabled: true,
  start: "07:30",
  end: "15:30",
  slots: [],
  specificTimes: [],
  slotsPerHour: 0,
  minLead: 0
};

function normalizeHhMm_(value, fallback) {
  const m = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallback;
  return (h < 10 ? "0" : "") + h + ":" + (mi < 10 ? "0" : "") + mi;
}

function normalizePickupSlots_(slots) {
  const list = Array.isArray(slots) ? slots : [];
  const out = [];
  list.forEach(s => {
    if (!s) return;
    const start = normalizeHhMm_(s.start, "");
    const end = normalizeHhMm_(s.end, "");
    if (!start || !end || start === end) return;
    if (out.length >= 12) return;
    out.push({ start: start, end: end });
  });
  return out;
}

// One-off pickup times, e.g. 12:30 and 14:45.
function normalizeSpecificTimes_(times) {
  const list = Array.isArray(times) ? times : [];
  const out = [];
  list.forEach(t => {
    const v = normalizeHhMm_(t, "");
    if (v && out.indexOf(v) < 0 && out.length < 48) out.push(v);
  });
  return out.sort();
}

function clampInt_(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function getOpeningHours() {
  const raw = PropertiesService.getScriptProperties().getProperty("OPENING_HOURS");
  if (!raw) return Object.assign({}, DEFAULT_OPENING_HOURS);
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled !== false,
      start: normalizeHhMm_(parsed.start, DEFAULT_OPENING_HOURS.start),
      end: normalizeHhMm_(parsed.end, DEFAULT_OPENING_HOURS.end),
      slots: normalizePickupSlots_(parsed.slots),
      specificTimes: normalizeSpecificTimes_(parsed.specificTimes),
      slotsPerHour: clampInt_(parsed.slotsPerHour, 0, 12, 0),
      minLead: clampInt_(parsed.minLead, 0, 240, 0)
    };
  } catch (e) {
    return Object.assign({}, DEFAULT_OPENING_HOURS);
  }
}

function setOpeningHours(hours) {
  const h = hours || {};
  const start = normalizeHhMm_(h.start, DEFAULT_OPENING_HOURS.start);
  const end = normalizeHhMm_(h.end, DEFAULT_OPENING_HOURS.end);
  if (start === end) return { success: false, error: "Opening and closing time cannot be the same" };
  const payload = {
    enabled: h.enabled !== false,
    start: start,
    end: end,
    slots: normalizePickupSlots_(h.slots),
    specificTimes: normalizeSpecificTimes_(h.specificTimes),
    slotsPerHour: clampInt_(h.slotsPerHour, 0, 12, 0),
    minLead: clampInt_(h.minLead, 0, 240, 0)
  };
  PropertiesService.getScriptProperties().setProperty("OPENING_HOURS", JSON.stringify(payload));
  bumpVersion();
  return { success: true, openingHours: payload };
}

function isPreorderWindowOpen() {
  const hours = getOpeningHours();
  if (!hours.enabled) return { open: true, hours: hours };
  const toMin = s => { const p = s.split(":"); return Number(p[0]) * 60 + Number(p[1]); };
  const nowHhMm = Utilities.formatDate(new Date(), "Asia/Hong_Kong", "HH:mm").split(":");
  const now = Number(nowHhMm[0]) * 60 + Number(nowHhMm[1]);
  const start = toMin(hours.start);
  const end = toMin(hours.end);
  // Supports overnight windows (e.g. 22:00–02:00) as well as normal ones.
  const open = start < end ? (now >= start && now < end) : (now >= start || now < end);
  return { open: open, hours: hours };
}

function closedPreorderMessage_(hours) {
  return "Pre-orders are closed right now. We open at " + hours.start +
    " and close at " + hours.end + ". Please order at the counter.";
}

// ==================== SELF-ORDER INSTRUCTIONS (User Manual) ====================
// Admins edit the "How to make a reservation order?" sheet. Each step has a
// short title and a longer body; guests read it from the Instructions button.
const DEFAULT_SELF_ORDER_INSTRUCTIONS = {
  title: "How to make a reservation order?",
  heading: "In only 4 steps~",
  steps: [
    { title: "Your full name input...", text: "We need your full name to know who you are...\nI.e. Mr Chung Lok Hoi / Mr Lai C.Z" },
    { title: "Your pickup time...", text: "Choose one of the available pickup times in the dropdown. Pick \"NOW\" if you are ordering on the spot (make sure the time is within opening hours!)" },
    { title: "Choose your drink...", text: "Drinks can be selected in the menu. You can choose to dine in, or take away. We have paper cups for take away orders.\n(Some beverages don't have cold option!)" },
    { title: "Done!", text: "Save the receipt in your device, and the barcode on receipt will be used for collecting drinks and for payments." }
  ],
  note: ""
};

// The teacher page, Open Day page and Bulky page keep separate copies.
function instructionsKey_(audience) {
  if (audience === "bulky") return "SELF_ORDER_INSTRUCTIONS_BULKY";
  if (audience === "openday") return "SELF_ORDER_INSTRUCTIONS_OPENDAY";
  return "SELF_ORDER_INSTRUCTIONS_TEACHER";
}

function getSelfOrderInstructions(audience) {
  const key = instructionsKey_(audience);
  let raw = PropertiesService.getScriptProperties().getProperty(key);
  // First run after the split: inherit the old shared copy only for the
  // teacher page (Open Day and Bulky get a blank default copy).
  if (!raw && audience !== "openday" && audience !== "bulky") {
    raw = PropertiesService.getScriptProperties().getProperty("SELF_ORDER_INSTRUCTIONS");
  }
  if (!raw) return DEFAULT_SELF_ORDER_INSTRUCTIONS;
  try {
    const parsed = JSON.parse(raw);
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const steps = rawSteps.map(s => {
      if (typeof s === "string") return { title: "", text: String(s).trim() };
      return { title: String((s && s.title) || "").trim(), text: String((s && s.text) || "").trim() };
    }).filter(s => s.title || s.text);
    return {
      title: String(parsed.title || "").trim() || DEFAULT_SELF_ORDER_INSTRUCTIONS.title,
      heading: String(parsed.heading || "").trim(),
      steps: steps.length ? steps : DEFAULT_SELF_ORDER_INSTRUCTIONS.steps,
      note: String(parsed.note || "").trim()
    };
  } catch (e) {
    return DEFAULT_SELF_ORDER_INSTRUCTIONS;
  }
}

function normalizeAudience_(audience) {
  if (audience === "bulky" || audience === "openday") return audience;
  return "teacher";
}

function setSelfOrderInstructions(audience, title, heading, steps, note) {
  const key = instructionsKey_(audience);
  const cleanAudience = normalizeAudience_(audience);
  const cleanTitle = String(title || "").trim();
  const cleanHeading = String(heading || "").trim();
  const list = Array.isArray(steps) ? steps : [];
  const cleanSteps = list.map(s => {
    if (typeof s === "string") return { title: "", text: String(s).trim() };
    return { title: String((s && s.title) || "").trim(), text: String((s && s.text) || "").trim() };
  }).filter(s => s.title || s.text);
  const cleanNote = String(note || "").trim();
  const props = PropertiesService.getScriptProperties();
  // Empty everything = reset back to the built-in copy.
  if (!cleanTitle && !cleanHeading && !cleanSteps.length && !cleanNote) {
    props.deleteProperty(key);
    bumpVersion();
    return { success: true, instructions: DEFAULT_SELF_ORDER_INSTRUCTIONS, audience: cleanAudience, reset: true };
  }
  const payload = {
    title: cleanTitle || DEFAULT_SELF_ORDER_INSTRUCTIONS.title,
    heading: cleanHeading,
    steps: cleanSteps,
    note: cleanNote,
    timestamp: Date.now()
  };
  props.setProperty(key, JSON.stringify(payload));
  bumpVersion();
  return { success: true, instructions: payload, audience: cleanAudience };
}

// ==================== PROMO POPUP (guest self-order) ====================
// Shown once per page load on the Customer / Open Day order pages.
function getPromoPopup() {
  const raw = PropertiesService.getScriptProperties().getProperty("PROMO_POPUP");
  if (!raw) return { active: false, title: "", body: "", imageUrl: "", timestamp: 0 };
  try {
    const parsed = JSON.parse(raw);
    return {
      active: parsed.active === true && (!!parsed.title || !!parsed.body || !!parsed.imageUrl),
      title: String(parsed.title || ""),
      body: String(parsed.body || ""),
      imageUrl: String(parsed.imageUrl || ""),
      timestamp: Number(parsed.timestamp) || 0
    };
  } catch (e) {
    return { active: false, title: "", body: "", imageUrl: "", timestamp: 0 };
  }
}

function setPromoPopup(title, body, imageUrl, active) {
  const payload = {
    active: active === true,
    title: String(title || "").trim(),
    body: String(body || "").trim(),
    imageUrl: String(imageUrl || "").trim(),
    timestamp: Date.now()
  };
  PropertiesService.getScriptProperties().setProperty("PROMO_POPUP", JSON.stringify(payload));
  bumpVersion();
  return { success: true, promoPopup: payload };
}

// ==================== PROMO CODES ====================
function ensurePromoCodesSheet(ss) {
  let sheet = ss.getSheetByName("PromoCodes");
  if (!sheet) {
    sheet = ss.insertSheet("PromoCodes");
    sheet.appendRow(["Code", "Type", "Value", "MinSpend", "Active", "Description", "BuyQty", "FreeQty"]);
  } else {
    const headers = sheet.getRange(1, 1, 1, 8).getValues()[0];
    if (!headers[6] || String(headers[6]).trim() === "") sheet.getRange(1, 7).setValue("BuyQty");
    if (!headers[7] || String(headers[7]).trim() === "") sheet.getRange(1, 8).setValue("FreeQty");
  }
  return sheet;
}

function getPromoCodes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensurePromoCodesSheet(ss);
  const data = sheet.getDataRange().getValues();
  const codes = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    const rawType = String(data[i][1] || "PERCENT").trim().toUpperCase();
    const type = rawType === "AMOUNT" ? "AMOUNT" : rawType === "BOGO" ? "BOGO" : "PERCENT";
    codes.push({
      code: String(data[i][0]).trim().toUpperCase(),
      type: type,
      value: Number(data[i][2]) || 0,
      minSpend: Number(data[i][3]) || 0,
      active: String(data[i][4] || "").trim().toUpperCase() === "TRUE",
      description: String(data[i][5] || "").trim(),
      buyQty: Number(data[i][6]) || 0,
      freeQty: Number(data[i][7]) || 0
    });
  }
  return codes;
}

function savePromoCode(entry) {
  const code = String((entry && entry.code) || "").trim().toUpperCase();
  if (!code) return { success: false, error: "Code is required" };
  const sheet = ensurePromoCodesSheet(SpreadsheetApp.getActiveSpreadsheet());
  const data = sheet.getDataRange().getValues();
  const rawType = String(entry.type || "PERCENT").toUpperCase();
  const type = rawType === "AMOUNT" ? "AMOUNT" : rawType === "BOGO" ? "BOGO" : "PERCENT";
  const buyQty = type === "BOGO" ? Math.max(1, Math.floor(Number(entry.buyQty) || 0)) : 0;
  const freeQty = type === "BOGO" ? Math.max(1, Math.floor(Number(entry.freeQty) || 0)) : 0;
  const row = [
    code,
    type,
    type === "BOGO" ? 0 : Number(entry.value) || 0,
    Number(entry.minSpend) || 0,
    entry.active === false ? "FALSE" : "TRUE",
    String(entry.description || "").trim(),
    buyQty,
    freeQty
  ];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toUpperCase() === code) {
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      SpreadsheetApp.flush();
      bumpVersion();
      return { success: true, promoCodes: getPromoCodes() };
    }
  }
  sheet.appendRow(row);
  SpreadsheetApp.flush();
  bumpVersion();
  return { success: true, promoCodes: getPromoCodes() };
}

function deletePromoCode(code) {
  const wanted = String(code || "").trim().toUpperCase();
  const sheet = ensurePromoCodesSheet(SpreadsheetApp.getActiveSpreadsheet());
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toUpperCase() === wanted) {
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      bumpVersion();
      return { success: true, promoCodes: getPromoCodes() };
    }
  }
  return { success: false, error: "Code not found" };
}

// Validates a code against the cart and returns the amount off.
// `unitPrices` (optional) is one entry per cup, used by buy-X-get-Y rules.
function validatePromoCode(code, subtotal, unitPrices) {
  const wanted = String(code || "").trim().toUpperCase();
  const prices = (Array.isArray(unitPrices) ? unitPrices : [])
    .map(p => Number(p) || 0)
    .filter(p => p > 0);
  const sub = Number(subtotal) || prices.reduce((s, p) => s + p, 0);
  if (!wanted) return { success: false, error: "Enter a promo code" };
  const match = getPromoCodes().filter(c => c.code === wanted)[0];
  if (!match) return { success: false, error: "Code not found" };
  if (!match.active) return { success: false, error: "This code is not active" };
  if (match.minSpend > 0 && sub < match.minSpend) {
    return { success: false, error: "Minimum spend $" + match.minSpend.toFixed(2) + " required" };
  }

  let discount = 0;
  let freeCups = 0;

  if (match.type === "BOGO") {
    const buy = Math.max(1, Number(match.buyQty) || 1);
    const free = Math.max(1, Number(match.freeQty) || 1);
    const group = buy + free;
    const cheapestFirst = prices.slice().sort((a, b) => a - b);
    const sets = Math.floor(cheapestFirst.length / group);
    freeCups = sets * free;
    // The free cups are the cheapest ones in the basket
    for (let i = 0; i < freeCups; i++) discount += cheapestFirst[i] || 0;
    if (!freeCups) {
      return { success: false, error: "Add " + group + " cups to use this code (" + buy + " bought + " + free + " free)" };
    }
  } else {
    const raw = match.type === "PERCENT" ? sub * (match.value / 100) : match.value;
    discount = raw;
  }

  discount = Math.max(0, Math.min(sub, Math.round(discount * 100) / 100));
  return {
    success: true,
    code: match.code,
    type: match.type,
    value: match.value,
    minSpend: match.minSpend || 0,
    buyQty: match.buyQty || 0,
    freeQty: match.freeQty || 0,
    freeCups: freeCups,
    discount: discount,
    description: match.description
  };
}

// ==================== KDS STATUS STRIP (bar pressure badges) ====================
// Live strip above the Bar KDS grid. Thresholds are fixed per drink category:
// 0 orders, 1–2, 3–5 and 6+. Admins can rename the strip and each badge.
const DEFAULT_KDS_STATUS_STRIP = {
  show: true,
  label: "Bar Status",
  noOrders: "CLEAR",
  steady: "STEADY",
  busy: "BUSY",
  behind: "BEHIND"
};

function getKdsStatusStrip() {
  const raw = PropertiesService.getScriptProperties().getProperty("KDS_STATUS_STRIP");
  if (!raw) return DEFAULT_KDS_STATUS_STRIP;
  try {
    const p = JSON.parse(raw);
    const pick = (key) => String(p[key] || "").trim() || DEFAULT_KDS_STATUS_STRIP[key];
    return {
      show: p.show !== false,
      label: pick("label"),
      noOrders: pick("noOrders"),
      steady: pick("steady"),
      busy: pick("busy"),
      behind: pick("behind")
    };
  } catch (e) {
    return DEFAULT_KDS_STATUS_STRIP;
  }
}

function setKdsStatusStrip(cfg) {
  const c = cfg || {};
  const payload = {
    show: c.show !== false,
    label: String(c.label || "").trim() || DEFAULT_KDS_STATUS_STRIP.label,
    noOrders: String(c.noOrders || "").trim() || DEFAULT_KDS_STATUS_STRIP.noOrders,
    steady: String(c.steady || "").trim() || DEFAULT_KDS_STATUS_STRIP.steady,
    busy: String(c.busy || "").trim() || DEFAULT_KDS_STATUS_STRIP.busy,
    behind: String(c.behind || "").trim() || DEFAULT_KDS_STATUS_STRIP.behind
  };
  PropertiesService.getScriptProperties().setProperty("KDS_STATUS_STRIP", JSON.stringify(payload));
  bumpVersion();
  return { success: true, statusStrip: payload };
}

// ==================== SMART DATA FETCH ====================
// getInitialData returns ACTIVE orders only (not CLEARED) for fast sync
function getInitialData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const usersSheet = ensureUsersSheet(ss);
  const usersData = usersSheet.getDataRange().getValues();
  let users = [];
  for (let i = 1; i < usersData.length; i++) {
    if (usersData[i][0]) {
      users.push({ username: String(usersData[i][0]), role: String(usersData[i][2] || "Staff"), userCode: String(usersData[i][3] || "1").trim(), canPrint: String(usersData[i][4] || "").trim().toUpperCase() === "TRUE", googleEmail: String(usersData[i][5] || "").trim(), staffCard: String(usersData[i][6] || "").trim() });
    }
  }

  const props = PropertiesService.getScriptProperties();
  let hotkeys = props.getProperty("REMARK_HOTKEYS") || "+ Less Ice, + No Sugar, + Oat Milk, + Extra Hot";

  // One-time migration: the old single reservation switch becomes both new switches
  const legacyReservation = props.getProperty("RESERVATION_OPEN");
  if (legacyReservation !== null) {
    if (props.getProperty("TEACHER_RESERVATION_OPEN") === null) {
      props.setProperty("TEACHER_RESERVATION_OPEN", legacyReservation);
    }
    if (props.getProperty("OPENDAY_RESERVATION_OPEN") === null) {
      props.setProperty("OPENDAY_RESERVATION_OPEN", legacyReservation);
    }
  }

  const coldExtra = getColdExtra();
  const coldPausedGlobal = getColdPaused();
  const teacherReservationOpen = getTeacherReservationOpen();
  const openDayReservationOpen = getOpenDayReservationOpen();
  const bulkyReservationOpen = getBulkyReservationOpen();
  const teacherPauseReason = getPauseReason("teacher");
  const openDayPauseReason = getPauseReason("openday");
  const bulkyPauseReason = getPauseReason("bulky");
  const pushMessage = getPushMessage();

  // Menu with category and cold pause
  const summarySheet = ss.getSheetByName("Financial & Menu Summary");
  let menu = [];
  if (summarySheet) {
    ensureMenuSheetColumns(summarySheet);
    const menuData = summarySheet.getDataRange().getValues();
    for (let i = 1; i < menuData.length; i++) {
      const row = menuData[i];
      if (row[0]) {
        const status = String(row[3] || "Active").trim();
        const tempOptions = String(row[1] || "Hot & Cold");
        const itemColdPaused = String(row[5] || "").trim().toLowerCase() === "true";
        // If global cold pause is on, items that are cold-only become effectively paused
        let effectiveStatus = status;
        if (coldPausedGlobal && tempOptions.trim() === "Cold") {
          effectiveStatus = "Paused";
        }
        menu.push({
          name: String(row[0]),
          tempOptions: tempOptions,
          price: Number(row[2]) || 0,
          status: status,
          effectiveStatus: effectiveStatus,
          available: effectiveStatus.toLowerCase() === "active",
          category: String(row[4] || "Other").trim(),
          coldPaused: itemColdPaused,
          imageUrl: String(row[6] || "").trim(),
          description: String(row[7] || "").trim(),
          allowNotes: String(row[8] || "").trim().toLowerCase() !== "false",
          soldOut: String(row[9] || "").trim().toLowerCase() === "true"
        });
      }
    }
  }

  // Active orders, plus CLEARED-but-unpaid orders so the cashier can still
  // collect the outstanding payment after the drink was handed out.
  const ordersSheet = ss.getSheetByName("Orders Log");
  let orders = [];
  if (ordersSheet) {
    const ordersData = ordersSheet.getDataRange().getValues();
    const ACTIVE_STATUSES = ["UNPAID", "PENDING", "ASSIGNED", "READY", "RESERVED"];
    for (let i = 1; i < ordersData.length; i++) {
      const row = ordersData[i];
      const status = String(row[9] || "").trim().toUpperCase();
      const paymentStatus = String(row[11] || "").trim().toUpperCase() || "PAID";
      // Served-but-unpaid orders must stay visible at the cashier until money
      // is collected, so CLEARED rows are sent too while payment is outstanding.
      const isServedUnpaid = status === "CLEARED" && paymentStatus === "UNPAID";
      if (!ACTIVE_STATUSES.includes(status) && !isServedUnpaid) continue;

      // --- Defensive: recover orderNum if Sheets mis-typed it as Date ---
      let rawNum = row[0];
      let orderNumStr = "";
      if (rawNum instanceof Date) {
        // Column A was auto-formatted as Date at some point — read from the
        // underlying display string instead and still skip the row if it does
        // not look like a valid order number after recovery.
        orderNumStr = String(rawNum).trim();
      } else {
        orderNumStr = String(rawNum || "").trim();
      }
      // A valid order number is either a plain integer ("1035") or a multi-cup
      // suffix ("1035-1", "1035-2"). Anything else (dates, garbage) is skipped
      // so KDS never renders a Date string as the order number.
      if (!/^\d+(-\d+)?$/.test(orderNumStr)) continue;

      orders.push({
        orderNum: orderNumStr,
        orderTime: row[1] ? (row[1] instanceof Date ? Utilities.formatDate(row[1], Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss'Z'") : String(row[1])) : "",
        pickupTime: row[2] ? String(row[2]).replace(/^'/, "") : "",
        cashier: String(row[3] || ""),
        guestName: String(row[4] || "Guest"),
        productName: String(row[5] || ""),
        temp: String(row[6] || ""),
        customization: String(row[7] || "").replace(/^'/, "").trim(),
        price: Number(row[8]) || 0,
        status: status,
        qrTile: row[10] ? String(row[10]).trim() : "",
        paymentStatus: paymentStatus,
        cupType: String(row[12] || "In-Store").trim() || "In-Store",
        discount: Number(row[13]) || 0,
        promoCode: String(row[14] || "").trim().toUpperCase(),
        discountBy: String(row[15] || "").trim()
      });
    }
  }

  // QR Tiles
  let tiles = [];
  try {
    const tilesSheet = ensureQRTilesSheet(ss);
    const tilesData = tilesSheet.getDataRange().getValues();
    for (let i = 1; i < tilesData.length; i++) {
      if (tilesData[i][0]) {
        tiles.push({ code: String(tilesData[i][0]).trim(), status: String(tilesData[i][1] || "Available").trim(), boundOrder: tilesData[i][2] ? String(tilesData[i][2]).trim() : "" });
      }
    }
  } catch (e) {}

  return {
    menu: menu,
    orders: orders,
    users: users,
    remarkHotkeys: hotkeys,
    categories: getCategories(),
    qrTiles: tiles,
    version: getVersion(),
    coldExtra: coldExtra,
    coldPaused: coldPausedGlobal,
    teacherReservationOpen: teacherReservationOpen,
    openDayReservationOpen: openDayReservationOpen,
    bulkyReservationOpen: bulkyReservationOpen,
    teacherPauseReason: teacherPauseReason,
    openDayPauseReason: openDayPauseReason,
    bulkyPauseReason: bulkyPauseReason,
    pushMessage: pushMessage,
    statusStrip: getKdsStatusStrip(),
    openingHours: getOpeningHours(),
    promoPopup: getPromoPopup(),
    promoCodes: getPromoCodes(),
    instructions: getSelfOrderInstructions("teacher"),
    instructionsTeacher: getSelfOrderInstructions("teacher"),
    instructionsOpenDay: getSelfOrderInstructions("openday"),
    instructionsBulky: getSelfOrderInstructions("bulky"),
    categoryColors: getCategoryColors(),
    receiptLayout: getReceiptLayout()
  };
}

// Admin financial log - returns recent N orders (including CLEARED)
function getOrderHistory(limit) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ordersSheet = ss.getSheetByName("Orders Log");
  if (!ordersSheet) return { orders: [], totalRevenue: 0, totalCount: 0 };

  const data = ordersSheet.getDataRange().getValues();
  const max = limit || 200;
  let orders = [];
  let revenue = 0;
  // Start from the end (most recent)
  for (let i = data.length - 1; i >= 1 && orders.length < max; i--) {
    const row = data[i];
    const status = String(row[9] || "").trim().toUpperCase();
    if (["UNPAID", "PENDING", "ASSIGNED", "READY", "CLEARED", "RESERVED"].includes(status)) {
      const paymentStatus = String(row[11] || "").trim().toUpperCase() || "PAID";
      orders.push({
        orderNum: row[0] instanceof Date ? String(row[0]).trim() : String(row[0] || "").trim(),
        orderTime: row[1] ? (row[1] instanceof Date ? Utilities.formatDate(row[1], Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss'Z'") : String(row[1])) : "",
        pickupTime: row[2] ? String(row[2]).replace(/^'/, "") : "",
        cashier: String(row[3] || ""),
        guestName: String(row[4] || "Guest"),
        productName: String(row[5] || ""),
        temp: String(row[6] || ""),
        customization: String(row[7] || "").replace(/^'/, "").trim(),
        price: Number(row[8]) || 0,
        status: status,
        qrTile: row[10] ? String(row[10]).trim() : "",
        paymentStatus: paymentStatus,
        cupType: String(row[12] || "In-Store").trim() || "In-Store",
        discount: Number(row[13]) || 0,
        promoCode: String(row[14] || "").trim().toUpperCase(),
        discountBy: String(row[15] || "").trim()
      });
      if (paymentStatus !== "UNPAID") revenue += (Number(row[8]) || 0) - (Number(row[13]) || 0);
    }
  }
  return { orders: orders, totalRevenue: revenue, totalCount: orders.length };
}

// ==================== ORDERS ====================
function getUserCodeForOrder(ss, order) {
  const usersSheet = ensureUsersSheet(ss);
  const usersData = usersSheet.getDataRange().getValues();
  const cashierSearch = String(order.cashier || "").trim().toLowerCase();
  const guestSearch = String(order.guestName || "").trim().toLowerCase();
  for (let i = 1; i < usersData.length; i++) {
    const uName = String(usersData[i][0]).trim().toLowerCase();
    const uCode = String(usersData[i][3] || "1").trim();
    if (uName && uCode && (uName === cashierSearch || uName === guestSearch)) {
      return parseInt(uCode, 10) || 1;
    }
  }
  if (order.userCode && !isNaN(parseInt(order.userCode, 10))) return parseInt(order.userCode, 10);
  return 1;
}

function calculateNextOrderNum(ordersData, userCode) {
  const prefixBase = userCode * 1000;
  const minRange = prefixBase + 1;
  const maxRange = prefixBase + 999;
  const ACTIVE_STATUSES = ["UNPAID", "PENDING", "ASSIGNED", "READY", "RESERVED"];

  let maxFound = prefixBase;
  const activeNumbers = {};

  for (let i = 1; i < ordersData.length; i++) {
    const num = parseInt(ordersData[i][0], 10);
    if (isNaN(num) || num < minRange || num > maxRange) continue;
    if (num > maxFound) maxFound = num;
    const status = String(ordersData[i][9] || "").trim().toUpperCase();
    // Numbers still held by a live order must never be handed out twice
    if (ACTIVE_STATUSES.indexOf(status) !== -1) activeNumbers[num] = true;
  }

  // Normal case: keep counting up
  const next = maxFound + 1;
  if (next <= maxRange && !activeNumbers[next]) return String(next);

  // Rollover: X999 -> X001, skipping any number an active order is still using
  const span = maxRange - minRange + 1;
  const startOffset = (next - minRange) % span;
  for (let step = 0; step < span; step++) {
    const candidate = minRange + ((startOffset + step) % span);
    if (!activeNumbers[candidate]) return String(candidate);
  }

  // Every number in this user's range is currently in use by a live order
  throw new Error("All order numbers in this range are in use. Please clear some orders first.");
}

function createOrderLocked(orderOrOrders) {
  const orders = Array.isArray(orderOrOrders) ? orderOrOrders : [orderOrOrders];
  if (!orders.length) return { success: false, error: "No items in this order." };
  if (orders.length > 20) return { success: false, error: "Too many cups in one order (max 20)." };

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { return { success: false, error: "Server busy, please retry." }; }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ensureOrdersSheet(ss);
    const data = sheet.getDataRange().getValues();

    const first = orders[0];
    const userCode = getUserCodeForOrder(ss, first);
    // One shared counter for the whole order: 1001, then 1001-1 / 1001-2 …
    const baseOrderNum = calculateNextOrderNum(data, userCode);
    const isMulti = orders.length > 1;
    const orderTime = first.orderTime || new Date().toISOString();
    const cashier = first.cashier || "Self-Order";
    const guestName = first.guestName || "Guest";
    const createdOrders = [];

    for (let idx = 0; idx < orders.length; idx++) {
      const order = orders[idx];
      const assignedOrderNum = isMulti ? baseOrderNum + "-" + (idx + 1) : baseOrderNum;

      let pickupTime = order.pickupTime || "";
      // Force pickup time to be stored as plain text in the sheet
      if (pickupTime && !String(pickupTime).startsWith("'")) pickupTime = "'" + pickupTime;
      const status = order.status || "PENDING";
      const qrTile = isMulti ? "" : (order.qrTile || "");
      let paymentStatus = String(order.paymentStatus || "").trim();
      if (!paymentStatus) {
        paymentStatus = (status === "UNPAID" || status === "RESERVED") ? "UNPAID" : "PAID";
      }

      let rawNote = String(order.customization || "").replace(/[\r\n]+/g, " ").trim();
      if (rawNote.startsWith("+") || rawNote.startsWith("=") || rawNote.startsWith("-")) rawNote = "'" + rawNote;

      // CupType: required. Only "In-Store" or "Takeaway" accepted.
      let cupType = String(order.cupType || "").trim();
      if (!cupType) {
        lock.releaseLock();
        return { success: false, error: "Cup type is required — please select In-Store or Takeaway." };
      }
      cupType = (cupType.toLowerCase() === "takeaway" || cupType === "Takeaway" || cupType === "外带") ? "Takeaway" : "In-Store";

      const price = Number(order.price) || 0;
      const discount = Math.max(0, Math.min(price, Number(order.discount) || 0));
      const promoCode = String(order.promoCode || "").trim().toUpperCase();
      const discountBy = String(order.discountBy || "").trim();

      const createdOrder = {
        orderNum: assignedOrderNum,
        orderTime: orderTime,
        pickupTime: pickupTime.replace(/^'/, ""),
        cashier: cashier,
        guestName: guestName,
        productName: order.productName,
        temp: order.temp,
        customization: rawNote.replace(/^'/, ""),
        price: price,
        discount: discount,
        promoCode: promoCode,
        discountBy: discountBy,
        status: status,
        qrTile: qrTile,
        paymentStatus: paymentStatus,
        cupType: cupType
      };

      sheet.appendRow([
        createdOrder.orderNum, createdOrder.orderTime, pickupTime,
        createdOrder.cashier, createdOrder.guestName, createdOrder.productName,
        createdOrder.temp, rawNote, createdOrder.price, createdOrder.status, createdOrder.qrTile,
        createdOrder.paymentStatus, cupType, discount, promoCode, discountBy
      ]);

      // Bind QR tile if provided — reject unknown tiles so we never end up
      // with an order that has a dangling qrTile no cashier can clear.
      if (qrTile) {
        const bind = bindTileToOrder(qrTile, assignedOrderNum);
        if (!bind.success) {
          lock.releaseLock();
          return { success: false, error: bind.error + " (tile '" + qrTile + "' does not exist in QR Tiles sheet)" };
        }
      }

      createdOrders.push(createdOrder);
    }

    // A bulky order may still hold one physical pickup tile for the whole
    // group. It is bound to the base number (1001), while each cup keeps its
    // own suffixed order number (1001-1, 1001-2).
    const groupTile = isMulti ? String(first.qrTile || "").trim() : "";
    if (groupTile) {
      const tileBind = bindTileToOrder(groupTile, baseOrderNum);
      if (!tileBind.success) {
        lock.releaseLock();
        return { success: false, error: tileBind.error + " (tile '" + groupTile + "')" };
      }
    }

    SpreadsheetApp.flush();
    bumpVersion();
    lock.releaseLock();
    return {
      success: true,
      orderNum: baseOrderNum,
      orders: createdOrders,
      order: createdOrders[0]
    };
  } catch (err) {
    lock.releaseLock();
    return { success: false, error: err.toString() };
  }
}

function updateOrderStatus(orderNum, newStatus) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureOrdersSheet(ss);
  const data = sheet.getDataRange().getValues();
  const target = String(orderNum).trim();
  const ACTIVE_STATUSES = ["UNPAID", "PENDING", "ASSIGNED", "READY", "RESERVED"];

  // Order numbers repeat after X999 rolls back to X001, so always pick the newest
  // row — preferably the newest one that is still active.
  let matchIndex = -1;
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim() !== target) continue;
    const status = String(data[i][9] || "").trim().toUpperCase();
    if (ACTIVE_STATUSES.indexOf(status) !== -1) { matchIndex = i; break; }
    if (matchIndex === -1) matchIndex = i;
  }

  if (matchIndex === -1) return { success: false, error: "Order not found" };

  sheet.getRange(matchIndex + 1, 10).setValue(newStatus);
  // Pickup time is user-specified text; do not auto-fill with ISO date
  // Free QR tile when order is cleared
  if (newStatus === "CLEARED") {
    const tile = data[matchIndex][10] ? String(data[matchIndex][10]).trim() : "";
    if (tile) freeTile(tile);
  }
  SpreadsheetApp.flush();
  bumpVersion();
  return { success: true, orderNum: orderNum, status: newStatus };
}

function confirmPaymentStatus(orderNum) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureOrdersSheet(ss);
  const data = sheet.getDataRange().getValues();
  const target = String(orderNum).trim();
  const ACTIVE_STATUSES = ["UNPAID", "PENDING", "ASSIGNED", "READY", "RESERVED"];

  // --- Multi-cup base number: pay every sibling row at once ---
  const baseMatch = target.match(/^(\d+)(?:-\d+)?$/);
  const isBase = !!baseMatch && !target.includes("-");
  if (isBase) {
    const base = baseMatch[1];
    const updated = [];
    for (let i = 1; i < data.length; i++) {
      const rowNum = String(data[i][0] || "").trim();
      if (rowNum !== base && !rowNum.startsWith(base + "-")) continue;
      const status = String(data[i][9] || "").trim().toUpperCase();
      const pay = String(data[i][11] || "PAID").trim().toUpperCase();
      if (status === "CLEARED" && pay === "PAID") continue; // already finished
      const nextStatus = (status === "RESERVED" || status === "UNPAID") ? "PENDING" : status;
      sheet.getRange(i + 1, 10).setValue(nextStatus);
      sheet.getRange(i + 1, 12).setValue("PAID");
      updated.push(rowNum);
    }
    if (!updated.length) return { success: false, error: "No active orders for " + target };
    SpreadsheetApp.flush();
    bumpVersion();
    return { success: true, orderNum: target, paid: updated, count: updated.length };
  }

  let matchIndex = -1;
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim() !== target) continue;
    const status = String(data[i][9] || "").trim().toUpperCase();
    if (ACTIVE_STATUSES.indexOf(status) !== -1) { matchIndex = i; break; }
    if (matchIndex === -1) matchIndex = i;
  }

  if (matchIndex === -1) return { success: false, error: "Order not found" };

  const currentStatus = String(data[matchIndex][9] || "").trim().toUpperCase();
  const nextStatus = currentStatus === "UNPAID" ? "PENDING" : currentStatus;
  sheet.getRange(matchIndex + 1, 10).setValue(nextStatus);
  sheet.getRange(matchIndex + 1, 12).setValue("PAID");
  SpreadsheetApp.flush();
  bumpVersion();
  return { success: true, orderNum: orderNum, status: nextStatus, paymentStatus: "PAID" };
}

// Scan a base number and flip every RESERVED row in the group to UNPAID so
// the cashier can collect payment, instead of having to scan each per-cup code.
function bulkActivateReserved(baseNum) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureOrdersSheet(ss);
  const data = sheet.getDataRange().getValues();
  const target = String(baseNum).trim();
  const baseMatch = target.match(/^(\d+)$/);
  if (!baseMatch) return { success: false, error: "Scan the base order number (e.g. 1035), not a per-cup code" };
  const base = baseMatch[1];

  let changed = 0;
  const updated = [];
  for (let i = 1; i < data.length; i++) {
    const rowNum = String(data[i][0] || "").trim();
    if (rowNum !== base && !rowNum.startsWith(base + "-")) continue;
    const status = String(data[i][9] || "").trim().toUpperCase();
    const pay = String(data[i][11] || "PAID").trim().toUpperCase();
    // Already paid or cleared — leave it alone
    if (status === "CLEARED" && pay === "PAID") continue;
    if (status === "RESERVED") {
      sheet.getRange(i + 1, 10).setValue("UNPAID");
      changed++;
    } else if (status === "UNPAID") {
      changed++; // already waiting for payment
    }
    updated.push(rowNum);
  }
  if (!updated.length) return { success: false, error: "No rows found for " + base };
  SpreadsheetApp.flush();
  bumpVersion();
  return { success: true, orderNum: base, activated: changed, total: updated.length };
}

// Clear an order from a scanned code. The scanner may read either:
//   1. the barcode on the guest's pre-order ticket -> encodes the ORDER number
//   2. the QR tile handed out at the counter       -> encodes the TILE number
// A bulky order shares one base number (1001) with per-cup rows (1001-1,
// 1001-2). Scanning the tile or the base number claims every remaining cup;
// scanning a suffixed number claims just that cup.
function clearOrderByTile(scannedCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureOrdersSheet(ss);
  const data = sheet.getDataRange().getValues();
  const target = String(scannedCode).trim().replace(/^#/, "");
  const ACTIVE = ["UNPAID", "PENDING", "ASSIGNED", "READY", "RESERVED"];

  // Newest group only: order numbers repeat after rollover, so old rows that
  // share the same base number must not be cleared by accident.
  function groupRows(base) {
    const idxs = [];
    for (let i = 1; i < data.length; i++) {
      const num = String(data[i][0]).trim();
      if (num === base || num.indexOf(base + "-") === 0) idxs.push(i);
    }
    if (!idxs.length) return [];
    let newest = "";
    idxs.forEach(i => {
      const t = String(data[i][1] || "");
      if (t > newest) newest = t;
    });
    return idxs.filter(i => String(data[i][1] || "") === newest);
  }

  function claim(base, via) {
    const rows = groupRows(base);
    if (!rows.length) return null;
    const clearRows = [];
    let remaining = 0;
    let lastStatus = "";
    rows.forEach(i => {
      const status = String(data[i][9] || "").trim().toUpperCase();
      lastStatus = status;
      if (ACTIVE.indexOf(status) !== -1) {
        if (status === "READY") clearRows.push(i);
        else remaining++;
      }
    });

    if (!clearRows.length) {
      if (remaining > 0) {
        return { success: false, error: "Order " + base + " is still " + lastStatus + " (not ready for pickup)." };
      }
      return { success: false, error: "Order " + base + " is already cleared." };
    }

    const claimed = [];
    clearRows.forEach(i => {
      claimed.push(String(data[i][0]).trim());
      const rowTile = data[i][10] ? String(data[i][10]).trim() : "";
      sheet.getRange(i + 1, 10).setValue("CLEARED");
      if (rowTile) freeTile(rowTile);
    });

    const allDone = remaining === 0;
    if (via === "tile" && allDone) freeTile(target);

    SpreadsheetApp.flush();
    bumpVersion();
    return {
      success: true,
      orderNum: base,
      claimed: claimed,
      cups: claimed.length,
      remaining: remaining,
      allDone: allDone,
      status: "CLEARED",
      via: via
    };
  }

  // --- Branch 1: scanned code is a known QR tile ---
  const tilesSheet = ss.getSheetByName("QR Tiles");
  let tileBoundOrder = "";
  let tileKnown = false;
  if (tilesSheet) {
    const tilesData = tilesSheet.getDataRange().getValues();
    for (let i = 1; i < tilesData.length; i++) {
      if (String(tilesData[i][0]).trim() === target) {
        tileKnown = true;
        tileBoundOrder = String(tilesData[i][2] || "").trim();
        break;
      }
    }
  }

  if (tileKnown) {
    if (!tileBoundOrder) {
      return { success: false, error: "Tile '" + target + "' exists but is not bound to any order." };
    }
    const res = claim(tileBoundOrder, "tile");
    if (res) return res;
    return { success: false, error: "Tile '" + target + "' is bound to " + tileBoundOrder + " but that order is missing from Orders Log." };
  }

  // --- Branch 2: scanned code is an order number (full or per-cup) ---
  // Prefer the newest row with an exact match; otherwise treat it as a base
  // number and claim the whole newest group.
  let exactIndex = -1;
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim() === target) { exactIndex = i; break; }
  }
  if (exactIndex !== -1 && target.indexOf("-") !== -1) {
    const rowTile = data[exactIndex][10] ? String(data[exactIndex][10]).trim() : "";
    const status = String(data[exactIndex][9] || "").trim().toUpperCase();
    if (ACTIVE.indexOf(status) === -1) {
      return { success: false, error: "Order " + target + " exists but is " + status + " — not clearable." };
    }
    sheet.getRange(exactIndex + 1, 10).setValue("CLEARED");
    if (rowTile) freeTile(rowTile);
    SpreadsheetApp.flush();
    bumpVersion();
    return { success: true, orderNum: target, claimed: [target], cups: 1, remaining: 0, allDone: true, status: "CLEARED", via: "orderNum" };
  }

  const groupRes = claim(target, "orderNum");
  if (groupRes) return groupRes;
  return { success: false, error: "'" + target + "' is neither a known QR tile code nor a valid order number." };
}

function deleteOrder(orderNum) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureOrdersSheet(ss);
  const data = sheet.getDataRange().getValues();
  const target = String(orderNum).trim();
  // Newest row wins, because order numbers repeat after the X999 rollover
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim() === target) {
      const tile = data[i][10] ? String(data[i][10]).trim() : "";
      if (tile) freeTile(tile);
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      bumpVersion();
      return { success: true, orderNum: orderNum };
    }
  }
  return { success: false, error: "Order not found" };
}

// Self-serve cancellation: a guest may cancel only their unpaid order.
// Paid orders must go through the cashier for a refund.
function cancelOrder(orderNum) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureOrdersSheet(ss);
  const data = sheet.getDataRange().getValues();
  const target = String(orderNum).trim();
  const ACTIVE_STATUSES = ["UNPAID", "PENDING", "ASSIGNED", "READY", "RESERVED"];

  let matchIndex = -1;
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim() !== target) continue;
    const status = String(data[i][9] || "").trim().toUpperCase();
    if (ACTIVE_STATUSES.indexOf(status) !== -1) { matchIndex = i; break; }
    if (matchIndex === -1) matchIndex = i;
  }

  if (matchIndex === -1) return { success: false, error: "Order not found" };

  const rowStatus = String(data[matchIndex][9] || "").trim().toUpperCase();
  const paymentStatus = String(data[matchIndex][11] || "").trim().toUpperCase();

  if (paymentStatus === "PAID") {
    return { success: false, error: "This order is already paid. Please ask the cashier for a refund — orders cannot be cancelled after payment." };
  }
  if (rowStatus === "CLEARED" || rowStatus === "CANCELLED") {
    return { success: false, error: "This order has already been completed or cancelled." };
  }

  sheet.getRange(matchIndex + 1, 10).setValue("CANCELLED");
  // Self-serve orders (openday / customer) don't bind a QR tile, but POS orders might.
  const tile = data[matchIndex][10] ? String(data[matchIndex][10]).trim() : "";
  if (tile) freeTile(tile);
  SpreadsheetApp.flush();
  bumpVersion();
  return { success: true, orderNum: orderNum, status: "CANCELLED" };
}

// ==================== QR TILES ====================
function bindTileToOrder(tileCode, orderNum) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureQRTilesSheet(ss);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(tileCode).trim()) {
      sheet.getRange(i + 1, 2).setValue("Bound");
      sheet.getRange(i + 1, 3).setValue(String(orderNum));
      return { success: true };
    }
  }
  return { success: false, error: "Tile not found" };
}

function freeTile(tileCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureQRTilesSheet(ss);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(tileCode).trim()) {
      sheet.getRange(i + 1, 2).setValue("Available");
      sheet.getRange(i + 1, 3).setValue("");
      return { success: true };
    }
  }
  return { success: false, error: "Tile not found" };
}

// ==================== WALLET PASS (WalletWallet) ====================
function createWalletPass(order) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty("WALLET_WALLET_API_KEY");
  if (!apiKey) {
    return { success: false, error: "Wallet API key not configured. Please set WALLET_WALLET_API_KEY in Script Properties." };
  }

  const payload = {
    logoText: "MFCafe",
    organizationName: "MFCafe",
    barcodeValue: String(order.orderNum),
    barcodeFormat: "Code128",
    barcodeAltText: String(order.orderNum),
    colorPreset: "orange",
    expirationDays: 1,
    primaryFields: [{ label: "ORDER", value: `#${order.orderNum}` }],
    secondaryFields: [
      { label: "GUEST", value: String(order.guestName || "Guest") },
      { label: "DRINK", value: `${order.productName || ""} (${order.temp || ""})`.trim() },
      { label: "PICKUP", value: String(order.pickupTime || "Scheduled").replace(/^'/, "") }
    ],
    backFields: [
      { label: "Status", value: String(order.status || "RESERVED") },
      { label: "Price", value: Number(order.price || 0).toFixed(2) }
    ]
  };

  try {
    const response = UrlFetchApp.fetch("https://api.walletwallet.dev/api/passes", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const status = response.getResponseCode();
    const body = response.getContentText();
    if (status >= 200 && status < 300) {
      const result = JSON.parse(body);
      return { success: true, shareUrl: result.shareUrl, googleSaveUrl: result.googleSaveUrl, applePass: result.applePass, serialNumber: result.serialNumber };
    }
    return { success: false, error: "WalletWallet API error " + status + ": " + body };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

function addQRTile(tileCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureQRTilesSheet(ss);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(tileCode).trim()) {
      return { success: false, error: "Tile code already exists" };
    }
  }
  sheet.appendRow([String(tileCode), "Available", ""]);
  bumpVersion();
  return { success: true };
}

function deleteQRTile(tileCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureQRTilesSheet(ss);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(tileCode).trim()) {
      sheet.deleteRow(i + 1);
      bumpVersion();
      return { success: true };
    }
  }
  return { success: false, error: "Tile not found" };
}

// ==================== MENU ====================
function toggleMenuItem(itemName, newStatus) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Financial & Menu Summary");
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(itemName).trim()) {
      sheet.getRange(i + 1, 4).setValue(newStatus);
      SpreadsheetApp.flush();
      bumpVersion();
      return { success: true };
    }
  }
  return { success: false, error: "Item not found" };
}

function saveMenuItem(item) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Financial & Menu Summary");
  ensureMenuSheetColumns(sheet);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(item.originalName || item.name).trim()) {
      sheet.getRange(i + 1, 1).setValue(item.name);
      sheet.getRange(i + 1, 2).setValue(item.tempOptions);
      sheet.getRange(i + 1, 3).setValue(item.price);
      sheet.getRange(i + 1, 4).setValue(item.status);
      sheet.getRange(i + 1, 5).setValue(item.category || "Other");
      sheet.getRange(i + 1, 6).setValue(item.coldPaused ? "true" : "false");
      sheet.getRange(i + 1, 7).setValue(String(item.imageUrl || "").trim());
      sheet.getRange(i + 1, 8).setValue(String(item.description || "").trim());
      sheet.getRange(i + 1, 9).setValue(item.allowNotes === false ? "false" : "true");
      sheet.getRange(i + 1, 10).setValue(item.soldOut ? "true" : "false");
      SpreadsheetApp.flush();
      bumpVersion();
      return { success: true };
    }
  }
  return { success: false, error: "Item not found" };
}

function addMenuItem(item) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Financial & Menu Summary");
  ensureMenuSheetColumns(sheet);
  sheet.appendRow([item.name, item.tempOptions, item.price, item.status || "Active", item.category || "Other", item.coldPaused ? "true" : "false", String(item.imageUrl || "").trim(),
    String(item.description || "").trim(), item.allowNotes === false ? "false" : "true", item.soldOut ? "true" : "false"]);
  SpreadsheetApp.flush();
  bumpVersion();
  return { success: true };
}

function deleteMenuItem(itemName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Financial & Menu Summary");
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(itemName).trim()) {
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      bumpVersion();
      return { success: true };
    }
  }
  return { success: false, error: "Item not found" };
}

// ==================== SELF-SERVICE ORDER LOOKUP ====================
// Resolves a scanned code (order number OR bound tile QR) into its current order
function lookupOrder(rawCode) {
  const code = String(rawCode || "").trim().replace(/^#/, "");
  if (!code) return { success: false, error: "Empty code" };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ordersSheet = ss.getSheetByName("Orders Log");
  if (!ordersSheet) return { success: false, error: "Orders sheet missing" };

  const data = ordersSheet.getDataRange().getValues();
  const ACTIVE = ["UNPAID", "PENDING", "ASSIGNED", "READY", "RESERVED"];
  let foundIndex = -1;

  // 1) Match by order number (prefer newest active order)
  for (let i = data.length - 1; i >= 1; i--) {
    const num = String(data[i][0]).trim();
    const status = String(data[i][9] || "").trim().toUpperCase();
    if (num === code && ACTIVE.includes(status)) {
      foundIndex = i;
      break;
    }
  }
  // 2) Fallback: exact newest order number, even if cleared
  if (foundIndex === -1) {
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]).trim() === code) { foundIndex = i; break; }
    }
  }

  // 3) Match by QR tile binding
  let tileStatus = "";
  let tileExists = false;
  let boundOrder = "";
  if (foundIndex === -1) {
    const tilesSheet = ss.getSheetByName("QR Tiles");
    if (tilesSheet) {
      const tilesData = tilesSheet.getDataRange().getValues();
      for (let i = 1; i < tilesData.length; i++) {
        if (String(tilesData[i][0]).trim() === code) {
          tileExists = true;
          tileStatus = String(tilesData[i][1] || "").trim();
          boundOrder = String(tilesData[i][2] || "").trim();
          break;
        }
      }
      if (boundOrder) {
        for (let i = data.length - 1; i >= 1; i--) {
          if (String(data[i][0]).trim() === boundOrder) { foundIndex = i; break; }
        }
      }
    }
  }

  if (foundIndex === -1) {
    let err = "Order not found";
    if (tileExists && !boundOrder) {
      err = "Tile '" + code + "' exists but is Available — not bound to any order yet.";
    } else if (tileExists && boundOrder) {
      err = "Tile '" + code + "' is bound to order " + boundOrder + " but that order is missing from Orders Log.";
    } else {
      err = "'" + code + "' is neither a known QR tile code nor a valid order number.";
    }
    return { success: false, error: err, scannedCode: code, tileStatus: tileStatus };
  }

  const row = data[foundIndex];
  const productName = String(row[5] || "");
  // Derive category from menu sheet so the UI can colour-code it
  let category = "Other";
  try {
    const menuSheet = ss.getSheetByName("Financial & Menu Summary");
    if (menuSheet) {
      const menuData = menuSheet.getDataRange().getValues();
      for (let i = 1; i < menuData.length; i++) {
        if (String(menuData[i][0]).trim() === productName.trim()) {
          category = String(menuData[i][4] || "Other").trim() || "Other";
          break;
        }
      }
    }
  } catch (e) {}

  return {
    success: true,
    order: {
      orderNum: row[0] instanceof Date ? String(row[0]).trim() : String(row[0] || "").trim(),
      orderTime: row[1] ? (row[1] instanceof Date ? Utilities.formatDate(row[1], Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss'Z'") : String(row[1])) : "",
      pickupTime: row[2] ? String(row[2]).replace(/^'/, "") : "",
      cashier: String(row[3] || ""),
      guestName: String(row[4] || "Guest"),
      productName: productName,
      temp: String(row[6] || ""),
      customization: String(row[7] || "").replace(/^'/, "").trim(),
      price: Number(row[8]) || 0,
      status: String(row[9] || "").trim().toUpperCase(),
      qrTile: row[10] ? String(row[10]).trim() : "",
      paymentStatus: String(row[11] || "").trim().toUpperCase() || "PAID",
      category: category,
      cupType: String(row[12] || "In-Store").trim() || "In-Store"
    },
    categoryColors: getCategoryColors()
  };
}

// ==================== HTTP ROUTING ====================
function doGet(e) {
  const action = e ? e.parameter.action : null;

  if (action === "checkUpdate") {
    return jsonResponse({ version: getVersion(), timestamp: Date.now() });
  }
  if (action === "getOrderHistory") {
    const limit = parseInt(e.parameter.limit, 10) || 200;
    return jsonResponse(getOrderHistory(limit));
  }
  if (action === "getCategories") {
    return jsonResponse({ categories: getCategories(), categoryColors: getCategoryColors() });
  }
  if (action === "lookupOrder") {
    return jsonResponse(lookupOrder(e.parameter.code));
  }

  return jsonResponse(getInitialData());
}

// ==================== REMOTE PRINT HUB ====================
// A single browser owns the BLE connection and becomes the "hub". Every other
// account (anywhere) queues a print job via Apps Script; the hub polls every
// 2s and prints it, then marks done. Hub status is refreshed every 15s so a
// dead hub (closed tab / lost connection) times out gracefully.

const PRINT_QUEUE_KEY = "PRINT_QUEUE";
const PRINT_HUB_KEY   = "PRINT_HUB";
const HUB_LEASE_MS    = 20000;  // heartbeat within this window keeps the hub valid

function _getQueue() {
  const raw = PropertiesService.getScriptProperties().getProperty(PRINT_QUEUE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

function _saveQueue(queue) {
  PropertiesService.getScriptProperties().setProperty(PRINT_QUEUE_KEY, JSON.stringify(queue.slice(-100)));
}

function queuePrintJob(orderNum, order) {
  const queue = _getQueue();
  // De-dupe: same order already queued → don't double
  if (queue.some(j => j.orderNum === orderNum && j.status === "pending")) {
    return { success: true, id: null, queued: false };
  }
  const job = {
    id: Utilities.getUuid(),
    orderNum: String(orderNum || ""),
    order: order || null,
    status: "pending",
    createdAt: Date.now(),
    startedAt: null,
    doneAt: null,
    error: null
  };
  queue.push(job);
  _saveQueue(queue);
  return { success: true, id: job.id, queued: true };
}

function pollPrintJobs() {
  const queue = _getQueue();
  const now = Date.now();
  // Re-queue anything stuck in "printing" for > 60s
  let changed = false;
  for (const j of queue) {
    if (j.status === "printing" && j.startedAt && (now - j.startedAt) > 60000) {
      j.status = "pending";
      j.startedAt = null;
      j.error = "timed out — requeued";
      changed = true;
    }
  }
  if (changed) _saveQueue(queue);
  return { success: true, jobs: queue.filter(j => j.status !== "done").slice(-10) };
}

function markPrintJobDone(id, error) {
  const queue = _getQueue();
  const now = Date.now();
  let found = false;
  for (const j of queue) {
    if (j.id === id) {
      j.status = error ? "pending" : "done";
      j.error = error || null;
      j.doneAt = now;
      // If failed, bump createdAt so it bubbles to the front again
      if (error) j.createdAt = now;
      found = true;
      break;
    }
  }
  _saveQueue(queue);
  return { success: true, found };
}

function setHub(hubId, printerName) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  let cur = null;
  try { cur = JSON.parse(props.getProperty(PRINT_HUB_KEY) || "null"); } catch (e) {}
  if (cur && cur.id !== hubId && (now - cur.lastSeen) < HUB_LEASE_MS) {
    return { success: false, error: "Another printer is already online — wait for it to drop" };
  }
  const hub = { id: hubId, printerName: printerName || "Unknown", lastSeen: now };
  props.setProperty(PRINT_HUB_KEY, JSON.stringify(hub));
  return { success: true, hub };
}

function getHubInfo() {
  const props = PropertiesService.getScriptProperties();
  let hub = null;
  try { hub = JSON.parse(props.getProperty(PRINT_HUB_KEY) || "null"); } catch (e) {}
  const now = Date.now();
  const alive = hub && (now - hub.lastSeen) < HUB_LEASE_MS;
  return {
    success: true,
    hub: alive ? { id: hub.id, printerName: hub.printerName, age: now - hub.lastSeen } : null
  };
}

// ==================== RECEIPT LAYOUT (editable in Admin → Receipt Layout) ====================
// Stored in Script Properties so every terminal prints the same template.
// Block shape:
//   { type: "logo" }
//   { type: "field", field: orderNum|productName|temp|cupType|guestName|
//                            qrTile|customization|time|price, prefix, suffix,
//                     align: left|center|right, size: 1|2|3, bold: bool }
//   { type: "text", text: "...", align, size, bold }
//   { type: "divider", align, size, bold }
//   { type: "feed", lines: 1..10 }
const RECEIPT_LAYOUT_KEY = "RECEIPT_LAYOUT_V1";

function defaultReceiptLayout() {
  return [
    { type: "field", field: "orderNum", prefix: "#", align: "center", size: 3, bold: true },
    { type: "field", field: "reserved", align: "center", size: 2, bold: true },
    { type: "field", field: "pickupTime", prefix: "Pickup: ", align: "center", size: 2, bold: true },
    { type: "divider", align: "center", size: 1, bold: false },
    { type: "field", field: "productName", align: "center", size: 2, bold: true },
    { type: "field", field: "cupType", align: "center", size: 1, bold: true },
    { type: "field", field: "temp", align: "center", size: 1, bold: false },
    { type: "field", field: "guestName", prefix: "Guest: ", align: "left", size: 1, bold: false },
    { type: "field", field: "qrTile", prefix: "Tile: ", align: "left", size: 1, bold: false },
    { type: "field", field: "customization", prefix: "Notes: ", align: "left", size: 1, bold: false },
    { type: "feed", lines: 3 }
  ];
}

function getReceiptLayout() {
  const raw = PropertiesService.getScriptProperties().getProperty(RECEIPT_LAYOUT_KEY);
  if (!raw) return defaultReceiptLayout();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : defaultReceiptLayout();
  } catch (e) {
    return defaultReceiptLayout();
  }
}

function saveReceiptLayout(layout) {
  if (!Array.isArray(layout) || layout.length === 0 || layout.length > 30) {
    return { success: false, error: "Invalid layout (1-30 blocks required)" };
  }
  const fields = ["orderNum", "reserved", "pickupTime", "productName", "temp", "cupType",
    "guestName", "qrTile", "customization", "time", "price"];
  const clean = layout.map(b => {
    const type = ["field", "text", "divider", "feed"].indexOf(String(b.type)) >= 0
      ? String(b.type) : "text";
    return {
      type: type,
      field: fields.indexOf(String(b.field)) >= 0 ? String(b.field) : "orderNum",
      text: String(b.text || "").slice(0, 60),
      prefix: String(b.prefix || "").slice(0, 30),
      suffix: String(b.suffix || "").slice(0, 30),
      align: ["left", "center", "right"].indexOf(String(b.align)) >= 0 ? String(b.align) : "left",
      size: [1, 2, 3].indexOf(Number(b.size)) >= 0 ? Number(b.size) : 1,
      bold: !!b.bold,
      lines: Math.max(1, Math.min(10, Number(b.lines) || 3))
    };
  });
  PropertiesService.getScriptProperties().setProperty(RECEIPT_LAYOUT_KEY, JSON.stringify(clean));
  bumpVersion();
  return { success: true, layout: clean };
}

function doPost(e) {
  try {
    let contents = e.postData.contents;
    let data;
    try { data = JSON.parse(contents); } catch (err) { data = JSON.parse(decodeURIComponent(contents)); }
    const action = data.action;

    if (action === "login") return jsonResponse(authenticateUser(data.username, data.password));
    if (action === "loginByStaffCode") return jsonResponse(authenticateByStaffCode(data.code));
    if (action === "loginGoogle") return jsonResponse(authenticateGoogle(data.credential));
    if (action === "addUser") return jsonResponse(addUser(data.username, data.password, data.role, data.userCode, data.staffCard));
    if (action === "deleteUser") return jsonResponse(deleteUser(data.username));
    if (action === "setUserCanPrint") return jsonResponse(setUserCanPrint(data.username, !!data.canPrint));
    if (action === "setUserStaffCard") return jsonResponse(setUserStaffCard(data.username, data.staffCard));
    if (action === "changeUserPassword") return jsonResponse(changeUserPassword(data.username, data.password));
    if (action === "setUserGoogleEmail") return jsonResponse(setUserGoogleEmail(data.username, data.email));
    if (action === "saveHotkeys") return jsonResponse(saveHotkeys(data.hotkeys));
    if (action === "saveCategories") return jsonResponse(saveCategories(data.categories));
    if (action === "saveCategoryColor") return jsonResponse(saveCategoryColor(data.category, data.color));

    if (action === "saveColdExtra") return jsonResponse(setColdExtra(data.value));
    if (action === "toggleColdPause") return jsonResponse(setColdPaused(data.paused));
    if (action === "toggleTeacherReservation") return jsonResponse(setTeacherReservationOpen(data.open));
    if (action === "toggleOpenDayReservation") return jsonResponse(setOpenDayReservationOpen(data.open));
    if (action === "toggleBulkyReservation") return jsonResponse(setBulkyReservationOpen(data.open));
    if (action === "savePauseReason") return jsonResponse(setPauseReason(data.target, data.reason));
    if (action === "savePushMessage") return jsonResponse(setPushMessage(data.text, data.sender, data.active));
    if (action === "saveKdsStatusStrip") return jsonResponse(setKdsStatusStrip(data.config));
    if (action === "saveOpeningHours") return jsonResponse(setOpeningHours(data.hours));
    if (action === "savePromoPopup") return jsonResponse(setPromoPopup(data.title, data.body, data.imageUrl, data.active));
    if (action === "saveInstructions") return jsonResponse(setSelfOrderInstructions(data.audience, data.title, data.heading, data.steps, data.note));
    if (action === "savePromoCode") return jsonResponse(savePromoCode(data.entry));
    if (action === "deletePromoCode") return jsonResponse(deletePromoCode(data.code));
    if (action === "validatePromoCode") return jsonResponse(validatePromoCode(data.code, data.subtotal, data.unitPrices));

    if (action === "createWalletPass") return jsonResponse(createWalletPass(data.order));

    if (action === "createOrder" || action === "createUnpaidOrder" || action === "createReservedOrder") {
      if (action === "createUnpaidOrder") data.order.status = "UNPAID";
      if (action === "createReservedOrder") {
        const win = isPreorderWindowOpen();
        if (!win.open) return jsonResponse({ success: false, error: closedPreorderMessage_(win.hours) });
        data.order.status = "RESERVED";
      }
      return jsonResponse(createOrderLocked(data.order));
    }

    // Multi-cup bulky order: every cup gets its own row and its own KDS block,
    // sharing one base number (1001-1, 1001-2, …).
    if (action === "createOrders") {
      if (!getBulkyReservationOpen()) return jsonResponse({ success: false, error: getPauseReason("bulky") });
      const win = isPreorderWindowOpen();
      if (!win.open) return jsonResponse({ success: false, error: closedPreorderMessage_(win.hours) });
      const items = Array.isArray(data.orders) ? data.orders : [];
      if (!items.length) return jsonResponse({ success: false, error: "No items in this order." });
      if (items.length > 20) return jsonResponse({ success: false, error: "Bulky orders are limited to 20 cups. Please split into multiple orders." });
      items.forEach(item => { item.status = "RESERVED"; });
      return jsonResponse(createOrderLocked(items));
    }
    if (action === "confirmPayment") return jsonResponse(confirmPaymentStatus(data.orderNum));
    if (action === "bulkActivateReserved") return jsonResponse(bulkActivateReserved(data.orderNum));
    if (action === "assignOrder") return jsonResponse(updateOrderStatus(data.orderNum, "ASSIGNED"));
    if (action === "unassignOrder") return jsonResponse(updateOrderStatus(data.orderNum, "PENDING"));
    if (action === "markReady") return jsonResponse(updateOrderStatus(data.orderNum, "READY"));
    if (action === "clearOrder") return jsonResponse(updateOrderStatus(data.orderNum, "CLEARED"));
    if (action === "clearOrderByTile") return jsonResponse(clearOrderByTile(data.tileCode));
    if (action === "deleteOrder") return jsonResponse(deleteOrder(data.orderNum));
    if (action === "cancelOrder") return jsonResponse(cancelOrder(data.orderNum));

    if (action === "toggleMenuItem") return jsonResponse(toggleMenuItem(data.itemName, data.newStatus));
    if (action === "saveMenuItem") return jsonResponse(saveMenuItem(data.item));
    if (action === "addMenuItem") return jsonResponse(addMenuItem(data.item));
    if (action === "deleteMenuItem") return jsonResponse(deleteMenuItem(data.itemName));

    if (action === "addQRTile") return jsonResponse(addQRTile(data.tileCode));
    if (action === "deleteQRTile") return jsonResponse(deleteQRTile(data.tileCode));

    // ----- Print Hub / Queue -----
    // Anyone can queue a job; the browser that holds the BLE connection
    // (the "print hub") polls these every ~2 seconds, prints, and marks done.
    if (action === "queuePrintJob") return jsonResponse(queuePrintJob(data.orderNum, data.order));
    if (action === "pollPrintJobs")  return jsonResponse(pollPrintJobs());
    if (action === "markPrintJobDone") return jsonResponse(markPrintJobDone(data.id));
    if (action === "hubHeartbeat")  return jsonResponse(setHub(data.hubId, data.printerName));
    if (action === "getHub")         return jsonResponse(getHubInfo());
    if (action === "saveReceiptLayout") return jsonResponse(saveReceiptLayout(data.layout));

  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}
