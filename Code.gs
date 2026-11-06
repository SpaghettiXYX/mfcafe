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
    usersSheet.appendRow(["Username", "Password", "Role", "UserCode", "CanPrint", "GoogleEmail"]);
    usersSheet.appendRow(["spaghetti", "123456", "Staff", "1", "FALSE", ""]);
    usersSheet.appendRow(["tl.li", "123456", "Admin", "2", "TRUE"]);
    usersSheet.appendRow(["ky.wong", "123456", "Admin", "3", "TRUE"]);
    usersSheet.appendRow(["ku", "123456", "Staff", "4", "FALSE"]);
  } else {
    const headers = usersSheet.getRange(1, 1, 1, 6).getValues()[0];
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
      "PaidTime", // when payment cleared — KDS count-up starts here
      "DiscountPct", "DiscountAmount", "DiscountBy"
    ]);
  } else {
    const headers = sheet.getRange(1, 1, 1, 17).getValues()[0];
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
    // PaidTime column (col 14) — existing paid rows are treated as paid at
    // order time so their KDS timers keep working after the migration.
    if (!headers[13] || String(headers[13]).trim() === "") {
      sheet.getRange(1, 14).setValue("PaidTime");
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const pay = String(data[i][11] || "").trim().toUpperCase();
        const orderTime = data[i][1];
        if (pay === "PAID" && orderTime) {
          sheet.getRange(i + 1, 14).setValue(orderTime instanceof Date ? orderTime.toISOString() : String(orderTime));
        }
      }
    }
    // Discount columns (15–17) — added when staff discounts shipped.
    if (!headers[14] || String(headers[14]).trim() === "") {
      sheet.getRange(1, 15, 1, 3).setValues([["DiscountPct", "DiscountAmount", "DiscountBy"]]);
    }
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
  const headers = sheet.getRange(1, 1, 1, 6).getValues()[0];
  if (!headers[4] || String(headers[4]).trim() === "") {
    sheet.getRange(1, 5).setValue("Category");
  }
  if (!headers[5] || String(headers[5]).trim() === "") {
    sheet.getRange(1, 6).setValue("ColdPaused");
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

// ==================== GOOGLE SIGN-IN ====================
// One-time setup (free):
//   1. console.cloud.google.com -> create a project
//   2. OAuth consent screen -> External -> fill app name + your email
//   3. Credentials -> Create OAuth Client ID -> Web application
//      Authorized JavaScript origins: https://<your-github-pages-host>
//   4. In the Apps Script editor run:  setGoogleClientId("xxxx.apps.googleusercontent.com")
// The client ID is public by design; security comes from verifying the token
// audience server-side and matching the email against the Users sheet.
const DEFAULT_GOOGLE_CLIENT_ID = "406055726787-9f7upjseefhfdam3j5e41bd22dvjnd91.apps.googleusercontent.com";
// Fallback so a fresh deployment works without running setGoogleClientId().
function getGoogleClientId() {
  return (PropertiesService.getScriptProperties().getProperty("GOOGLE_CLIENT_ID") || DEFAULT_GOOGLE_CLIENT_ID).trim();
}
function setGoogleClientId(id) {
  PropertiesService.getScriptProperties().setProperty("GOOGLE_CLIENT_ID", String(id || "").trim());
  return { success: true, googleClientId: getGoogleClientId() };
}

function authenticateGoogle(credential) {
  const clientId = getGoogleClientId();
  if (!clientId) return { success: false, error: "Google login is not configured yet" };
  if (!credential) return { success: false, error: "Missing Google credential" };
  let info;
  try {
    const resp = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential),
      { muteHttpExceptions: true });
    const code = resp.getResponseCode();
    if (code !== 200) {
      const body = resp.getContentText();
      return { success: false, error: "Google token verification failed (HTTP " + code + "): " + body.slice(0, 300) };
    }
    info = JSON.parse(resp.getContentText());
  } catch (err) {
    const msg = String(err.message || err);
    if (/permission|scope|external_request|UrlFetchApp/i.test(msg)) {
      return {
        success: false,
        error: "Google sign-in needs the script.external_request permission. In the Apps Script editor open appsscript.json, add \"https://www.googleapis.com/auth/script.external_request\", then run any function once and approve access, and deploy a new version."
      };
    }
    return { success: false, error: "Google token verification failed (exception): " + msg };
  }
  if (String(info.aud || "") !== clientId) {
    return { success: false, error: "Google token audience mismatch (got " + String(info.aud) + ", expected " + clientId + ")" };
  }
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

function addUser(username, password, role, userCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ensureUsersSheet(ss);
  const canPrint = (role || "Staff").toLowerCase() === "Admin" ? "TRUE" : "FALSE";
  usersSheet.appendRow([username, password, role || "Staff", userCode || "1", canPrint]);
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

// Pause reason shown on customer/openday pages when ordering is paused
function getPauseReason(target) {
  const key = target === "teacher" ? "PAUSE_REASON_TEACHER" : "PAUSE_REASON_OPENDAY";
  const defaults = {
    teacher: "Online pre-order is temporarily paused. Please order at the counter.",
    openday: "Open Day pre-order is temporarily paused. Please order at the counter."
  };
  return PropertiesService.getScriptProperties().getProperty(key) || defaults[target] || defaults.teacher;
}

function setPauseReason(target, reason) {
  const key = target === "teacher" ? "PAUSE_REASON_TEACHER" : "PAUSE_REASON_OPENDAY";
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

// ==================== SMART DATA FETCH ====================
// getInitialData returns ACTIVE orders only (not CLEARED) for fast sync
function getInitialData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const usersSheet = ensureUsersSheet(ss);
  const usersData = usersSheet.getDataRange().getValues();
  let users = [];
  for (let i = 1; i < usersData.length; i++) {
    if (usersData[i][0]) {
      users.push({ username: String(usersData[i][0]), role: String(usersData[i][2] || "Staff"), userCode: String(usersData[i][3] || "1").trim(), canPrint: String(usersData[i][4] || "").trim().toUpperCase() === "TRUE", googleEmail: String(usersData[i][5] || "").trim() });
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
  const teacherPauseReason = getPauseReason("teacher");
  const openDayPauseReason = getPauseReason("openday");
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
          coldPaused: itemColdPaused
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
      orders.push({
        orderNum: String(row[0]).trim(),
        orderTime: row[1] ? String(row[1]) : "",
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
        paidTime: row[13] ? String(row[13]) : "",
        discountPct: Number(row[14]) || 0,
        discountAmount: Number(row[15]) || 0,
        discountBy: String(row[16] || "").trim()
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
    teacherPauseReason: teacherPauseReason,
    openDayPauseReason: openDayPauseReason,
    pushMessage: pushMessage,
    categoryColors: getCategoryColors(),
    receiptLayout: getReceiptLayout(),
    orderGuides: getOrderGuides(),
    pickupConfig: getPickupConfig(),
    announcements: getAnnouncements(),
    kdsStatus: getKdsStatusConfig(),
    staffCards: getStaffCards()
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
        orderNum: String(row[0]).trim(),
        orderTime: row[1] ? String(row[1]) : "",
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
        paidTime: row[13] ? String(row[13]) : "",
        discountPct: Number(row[14]) || 0,
        discountAmount: Number(row[15]) || 0,
        discountBy: String(row[16] || "").trim()
      });
      if (paymentStatus !== "UNPAID") revenue += Number(row[8]) || 0;
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

function createOrderLocked(order) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { return { success: false, error: "Server busy, please retry." }; }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ensureOrdersSheet(ss);
    const data = sheet.getDataRange().getValues();

    const userCode = getUserCodeForOrder(ss, order);
    const assignedOrderNum = calculateNextOrderNum(data, userCode);

    const orderTime = order.orderTime || new Date().toISOString();
    let pickupTime = order.pickupTime || "";
    // Force pickup time to be stored as plain text in the sheet
    if (pickupTime && !String(pickupTime).startsWith("'")) pickupTime = "'" + pickupTime;
    const cashier = order.cashier || "Self-Order";
    const guestName = order.guestName || "Guest";
    const status = order.status || "PENDING";
    const qrTile = order.qrTile || "";
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

    // Staff discount: Price always stores what the guest actually pays, so
    // every existing revenue/KDS calculation keeps working unchanged.
    const originalPrice = Number(order.price) || 0;
    let discountPct = Number(order.discountPct) || 0;
    if (!isFinite(discountPct) || discountPct < 0) discountPct = 0;
    if (discountPct > 100) discountPct = 100;
    discountPct = Math.round(discountPct * 100) / 100;
    const discountAmount = discountPct > 0 ? Math.round(originalPrice * discountPct) / 100 : 0;
    const finalPrice = Math.max(0, Math.round((originalPrice - discountAmount) * 100) / 100);
    const discountBy = String(order.discountBy || "").trim().slice(0, 40);

    const createdOrder = {
      orderNum: assignedOrderNum,
      orderTime: orderTime,
      pickupTime: pickupTime.replace(/^'/, ""),
      cashier: cashier,
      guestName: guestName,
      productName: order.productName,
      temp: order.temp,
      customization: rawNote.replace(/^'/, ""),
      price: finalPrice,
      status: status,
      qrTile: qrTile,
      paymentStatus: paymentStatus,
      cupType: cupType,
      paidTime: paymentStatus === "PAID" ? orderTime : "",
      discountPct: discountPct,
      discountAmount: discountAmount,
      discountBy: discountPct > 0 ? discountBy : ""
    };

    sheet.appendRow([
      createdOrder.orderNum, createdOrder.orderTime, pickupTime,
      createdOrder.cashier, createdOrder.guestName, createdOrder.productName,
      createdOrder.temp, rawNote, createdOrder.price, createdOrder.status, createdOrder.qrTile,
      createdOrder.paymentStatus, cupType, createdOrder.paidTime,
      createdOrder.discountPct, createdOrder.discountAmount, createdOrder.discountBy
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

    SpreadsheetApp.flush();
    bumpVersion();
    lock.releaseLock();
    return { success: true, orderNum: assignedOrderNum, order: createdOrder };
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
  const paidAt = new Date().toISOString();
  sheet.getRange(matchIndex + 1, 10).setValue(nextStatus);
  sheet.getRange(matchIndex + 1, 12).setValue("PAID");
  sheet.getRange(matchIndex + 1, 14).setValue(paidAt);
  SpreadsheetApp.flush();
  bumpVersion();
  return { success: true, orderNum: orderNum, status: nextStatus, paymentStatus: "PAID", paidTime: paidAt };
}

// Clear an order from a scanned code. The scanner may read either:
//   1. the barcode on the guest's pre-order ticket -> encodes the ORDER number
//   2. the QR tile handed out at the counter       -> encodes the TILE number
// Both are resolved to the newest matching row, because order numbers repeat
// after X999 rolls back to X001.
function clearOrderByTile(scannedCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureOrdersSheet(ss);
  const data = sheet.getDataRange().getValues();
  const target = String(scannedCode).trim().replace(/^#/, "");
  const CLEARABLE = ["UNPAID", "PENDING", "ASSIGNED", "READY", "RESERVED"];

  // --- First, figure out what the scanned code is ---
  const tilesSheet = ss.getSheetByName("QR Tiles");
  let tileRow = -1;
  let tileBoundOrder = "";
  let tileStatusText = "";
  if (tilesSheet) {
    const tilesData = tilesSheet.getDataRange().getValues();
    for (let i = 1; i < tilesData.length; i++) {
      if (String(tilesData[i][0]).trim() === target) {
        tileRow = i;
        tileStatusText = String(tilesData[i][1] || "").trim();
        tileBoundOrder = String(tilesData[i][2] || "").trim();
        break;
      }
    }
  }

  // --- Branch 1: scanned code is a known QR tile ---
  if (tileRow !== -1) {
    if (!tileBoundOrder) {
      return { success: false, error: "Tile '" + target + "' exists but is not bound to any order." };
    }
    // Find the bound order in Orders Log
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]).trim() !== tileBoundOrder) continue;
      const status = String(data[i][9] || "").trim().toUpperCase();
      if (status === "READY") {
        sheet.getRange(i + 1, 10).setValue("CLEARED");
        freeTile(target);
        SpreadsheetApp.flush();
        bumpVersion();
        return { success: true, orderNum: tileBoundOrder, status: "CLEARED", via: "tile" };
      } else if (status === "CLEARED" || status === "CANCELLED") {
        return { success: false, error: "Tile '" + target + "' is bound to order " + tileBoundOrder + " which is already " + status + "." };
      } else {
        return { success: false, error: "Tile '" + target + "' is bound to order " + tileBoundOrder + " which is still " + status + " (not ready for pickup)." };
      }
    }
    // Tile says bound but the order row is missing — data inconsistency
    return { success: false, error: "Tile '" + target + "' is marked as bound to " + tileBoundOrder + " but that order is missing from Orders Log." };
  }

  // --- Branch 2: scanned code is NOT a tile — try as an order number ---
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim() !== target) continue;
    const status = String(data[i][9] || "").trim().toUpperCase();
    if (CLEARABLE.indexOf(status) === -1) {
      return { success: false, error: "Order " + target + " exists but is " + status + " — not clearable." };
    }
    const rowTile = data[i][10] ? String(data[i][10]).trim() : "";
    sheet.getRange(i + 1, 10).setValue("CLEARED");
    if (rowTile) freeTile(rowTile);
    SpreadsheetApp.flush();
    bumpVersion();
    return { success: true, orderNum: target, status: "CLEARED", via: "orderNum" };
  }

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
  sheet.appendRow([item.name, item.tempOptions, item.price, item.status || "Active", item.category || "Other", item.coldPaused ? "true" : "false"]);
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
      orderNum: String(row[0]).trim(),
      orderTime: row[1] ? String(row[1]) : "",
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

// ==================== KDS STATUS BADGES ====================
// The Bar KDS shows a live status strip; Admin owns every word on it.
const KDS_STATUS_KEY = "KDS_STATUS_CONFIG";
const KDS_STATUS_DEFAULTS = {
  enabled: true,
  title: "Bar Status",
  labels: { idle: "Clear", normal: "Steady", busy: "Busy", critical: "Behind", free: "Ready for next" }
};

function normalizeKdsStatusConfig(raw) {
  const src = (raw && typeof raw === "object") ? raw : {};
  const labels = (src.labels && typeof src.labels === "object") ? src.labels : {};
  const out = {
    enabled: src.enabled === undefined ? KDS_STATUS_DEFAULTS.enabled : !!src.enabled,
    title: String(src.title || KDS_STATUS_DEFAULTS.title).trim().slice(0, 24) || KDS_STATUS_DEFAULTS.title,
    labels: {}
  };
  Object.keys(KDS_STATUS_DEFAULTS.labels).forEach(k => {
    const v = String(labels[k] || "").trim().slice(0, 18);
    out.labels[k] = v || KDS_STATUS_DEFAULTS.labels[k];
  });
  return out;
}

function getKdsStatusConfig() {
  const raw = PropertiesService.getScriptProperties().getProperty(KDS_STATUS_KEY);
  if (!raw) return normalizeKdsStatusConfig(null);
  try {
    return normalizeKdsStatusConfig(JSON.parse(raw));
  } catch (e) {
    return normalizeKdsStatusConfig(null);
  }
}

function saveKdsStatusConfig(config) {
  const clean = normalizeKdsStatusConfig(config);
  PropertiesService.getScriptProperties().setProperty(KDS_STATUS_KEY, JSON.stringify(clean));
  bumpVersion();
  return { success: true, kdsStatus: clean };
}

// ==================== STAFF CARDS ====================
// One physical card may open several accounts, so the map is
// { cardCode: [username, ...] } and the portal asks which account to enter.
const STAFF_CARD_KEY = "STAFF_CARD_MAP";

function normalizeStaffCards(raw) {
  const src = (raw && typeof raw === "object") ? raw : {};
  const out = {};
  let kept = 0;
  Object.keys(src).forEach(code => {
    if (kept >= 60) return;
    const key = String(code).trim().slice(0, 40);
    if (!key) return;
    const list = Array.isArray(src[code]) ? src[code] : [];
    const accounts = list.map(x => String(x).trim()).filter(Boolean).slice(0, 12);
    const unique = accounts.filter((x, i) => accounts.indexOf(x) === i);
    if (unique.length) {
      out[key] = unique;
      kept++;
    }
  });
  return out;
}

function getStaffCards() {
  const raw = PropertiesService.getScriptProperties().getProperty(STAFF_CARD_KEY);
  if (!raw) return {};
  try {
    return normalizeStaffCards(JSON.parse(raw));
  } catch (e) {
    return {};
  }
}

function saveStaffCards(config) {
  const clean = normalizeStaffCards(config);
  PropertiesService.getScriptProperties().setProperty(STAFF_CARD_KEY, JSON.stringify(clean));
  bumpVersion();
  return { success: true, staffCards: clean };
}

// Resolve a scanned card before the client has loaded the Users sheet
// (the login screen appears before initial data is fetched).
function getCardAccounts(cardCode) {
  const code = String(cardCode || "").trim();
  if (!code) return [];
  const map = getStaffCards();
  const names = Array.isArray(map[code]) ? map[code] : [];
  if (!names.length) return [];
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users");
  const rows = sheet ? sheet.getDataRange().getValues() : [];
  const out = [];
  rows.slice(1).forEach(row => {
    const uname = String(row[0] || "").trim();
    if (!uname) return;
    if (!names.some(n => String(n).toLowerCase() === uname.toLowerCase())) return;
    out.push({
      username: uname,
      role: String(row[2] || "Staff").trim(),
      canPrint: String(row[4] || "").trim().toUpperCase() === "TRUE"
    });
  });
  return out;
}

// ==================== SELF-ORDER GUIDE ====================
// Copy for the "How self-ordering works" pop-up. One guide per portal so the
// teacher counter and Open Day can explain themselves differently.
const ORDER_GUIDE_KEY = "ORDER_GUIDE";

const DEFAULT_ORDER_GUIDES = {
  customer: {
    kicker: "How self-ordering works",
    heading: "You're all set",
    steps: [
      { title: "Keep this ticket", body: "Your barcode is the proof of this order. Staff will scan it when you pick up." },
      { title: "Show it at 2/F Chill Zone", body: "Hand the barcode to the counter so we can confirm your drink and pickup time." },
      { title: "Watch for your number", body: "Your order number is called on the pickup screen as soon as it's ready." },
      { title: "Collect and enjoy", body: "Pick your drink up at the service counter. Keep this page open to check status." }
    ]
  },
  openday: {
    kicker: "How self-ordering works",
    heading: "Almost there",
    steps: [
      { title: "Show the barcode to pay", body: "Take this ticket to the 2/F Chill Zone cashier. Scanning it confirms your payment." },
      { title: "Payment comes first", body: "Drinks are only crafted after payment is confirmed. No payment, no drink." },
      { title: "Watch for your number", body: "The pickup screen calls your order number once your drink is ready." },
      { title: "Collect and enjoy", body: "Grab your drink at the service counter. Keep this page open to track the order." }
    ]
  }
};

function normalizeOrderGuide(saved, fallback) {
  const src = saved || {};
  const savedSteps = Array.isArray(src.steps) ? src.steps : [];
  return {
    kicker: String(src.kicker || fallback.kicker).trim().slice(0, 40) || fallback.kicker,
    heading: String(src.heading || fallback.heading).trim().slice(0, 40) || fallback.heading,
    steps: fallback.steps.map((def, i) => {
      const s = savedSteps[i] || {};
      return {
        title: String(s.title || "").trim().slice(0, 60) || def.title,
        body: String(s.body || "").trim().slice(0, 220) || def.body
      };
    })
  };
}

function getOrderGuides() {
  let saved = {};
  try {
    saved = JSON.parse(PropertiesService.getScriptProperties().getProperty(ORDER_GUIDE_KEY) || "{}");
  } catch (e) {
    saved = {};
  }
  return {
    customer: normalizeOrderGuide(saved.customer, DEFAULT_ORDER_GUIDES.customer),
    openday: normalizeOrderGuide(saved.openday, DEFAULT_ORDER_GUIDES.openday)
  };
}

function saveOrderGuide(mode, guide) {
  if (mode !== "customer" && mode !== "openday") {
    return { success: false, error: "Unknown guide: " + mode };
  }
  const props = PropertiesService.getScriptProperties();
  let all = {};
  try {
    all = JSON.parse(props.getProperty(ORDER_GUIDE_KEY) || "{}");
  } catch (e) {
    all = {};
  }
  // An empty guide resets that portal back to the shipped defaults.
  all[mode] = normalizeOrderGuide(guide || {}, DEFAULT_ORDER_GUIDES[mode]);
  props.setProperty(ORDER_GUIDE_KEY, JSON.stringify(all));
  bumpVersion();
  return { success: true, orderGuides: getOrderGuides() };
}

// ==================== PICKUP TIME SLOTS ====================
// The self-order portals build their "pickup time" menu from these opening
// hours, so a guest can never pick a slot while the bar is closed.
const PICKUP_CONFIG_KEY = "PICKUP_CONFIG";
const DEFAULT_PICKUP_CONFIG = { enabled: true, open: "08:00", close: "18:00", intervalMin: 15, leadMin: 10, customSlots: [] };

function normalizePickupConfig(src) {
  src = src || {};
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  const open = timeRe.test(String(src.open || "")) ? String(src.open) : DEFAULT_PICKUP_CONFIG.open;
  const close = timeRe.test(String(src.close || "")) ? String(src.close) : DEFAULT_PICKUP_CONFIG.close;
  let intervalMin = Number(src.intervalMin);
  if (!isFinite(intervalMin) || intervalMin <= 0) intervalMin = DEFAULT_PICKUP_CONFIG.intervalMin;
  intervalMin = Math.min(120, Math.max(5, Math.round(intervalMin)));
  let leadMin = Number(src.leadMin);
  if (!isFinite(leadMin) || leadMin < 0) leadMin = DEFAULT_PICKUP_CONFIG.leadMin;
  leadMin = Math.min(180, Math.round(leadMin));
  // Admin-defined exact times. When any are present they replace the
  // generated open/close/interval grid on the portals.
  const customSlots = [];
  const seen = {};
  (Array.isArray(src.customSlots) ? src.customSlots : []).forEach(function (raw) {
    const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(raw || "").trim());
    if (!m || Number(m[1]) > 23 || customSlots.length >= 48) return;
    const t = (m[1].length === 1 ? "0" + m[1] : m[1]) + ":" + m[2];
    if (!seen[t]) { seen[t] = true; customSlots.push(t); }
  });
  customSlots.sort();
  return { enabled: src.enabled !== false, open: open, close: close, intervalMin: intervalMin, leadMin: leadMin, customSlots: customSlots };
}

function getPickupConfig() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(PICKUP_CONFIG_KEY);
    return normalizePickupConfig(raw ? JSON.parse(raw) : {});
  } catch (e) {
    return normalizePickupConfig({});
  }
}

function savePickupConfig(config) {
  const normalized = normalizePickupConfig(config || {});
  PropertiesService.getScriptProperties().setProperty(PICKUP_CONFIG_KEY, JSON.stringify(normalized));
  bumpVersion();
  return { success: true, pickupConfig: normalized };
}

// ==================== PORTAL ANNOUNCEMENTS ====================
// Entry pop-ups for customer.html / openday.html. Stored as one property so
// saving is atomic; the portals show them again on every page load.
const ANNOUNCEMENTS_KEY = "PORTAL_ANNOUNCEMENTS";
const MAX_ANNOUNCEMENTS = 12;

function normalizeAnnouncement(a, i) {
  a = a || {};
  const pages = ["customer", "openday"];
  const showOn = Array.isArray(a.showOn) ? a.showOn.filter(p => pages.indexOf(p) !== -1) : pages;
  return {
    id: String(a.id || ("ann-" + (i + 1))).trim().slice(0, 40),
    enabled: a.enabled !== false,
    showOn: showOn.length ? showOn : pages,
    title: String(a.title || "").trim().slice(0, 70),
    body: String(a.body || "").trim().slice(0, 600),
    imageUrl: String(a.imageUrl || "").trim().slice(0, 2000),
    buttonText: String(a.buttonText || "").trim().slice(0, 30)
  };
}

function getAnnouncements() {
  let saved = {};
  try {
    saved = JSON.parse(PropertiesService.getScriptProperties().getProperty(ANNOUNCEMENTS_KEY) || "{}");
  } catch (e) {
    saved = {};
  }
  const items = Array.isArray(saved.items) ? saved.items : [];
  return {
    enabled: saved.enabled !== false,
    items: items.slice(0, MAX_ANNOUNCEMENTS).map(normalizeAnnouncement)
  };
}

function saveAnnouncements(config) {
  config = config || {};
  const rawItems = Array.isArray(config.items) ? config.items : [];
  if (rawItems.length > MAX_ANNOUNCEMENTS) {
    return { success: false, error: "Too many pop-ups (max " + MAX_ANNOUNCEMENTS + ")" };
  }
  const clean = {
    enabled: config.enabled !== false,
    items: rawItems.map(normalizeAnnouncement)
  };
  PropertiesService.getScriptProperties().setProperty(ANNOUNCEMENTS_KEY, JSON.stringify(clean));
  bumpVersion();
  return { success: true, announcements: clean };
}

function doPost(e) {
  try {
    let contents = e.postData.contents;
    let data;
    try { data = JSON.parse(contents); } catch (err) { data = JSON.parse(decodeURIComponent(contents)); }
    const action = data.action;

    if (action === "login") return jsonResponse(authenticateUser(data.username, data.password));
    if (action === "loginGoogle") return jsonResponse(authenticateGoogle(data.credential));
    if (action === "addUser") return jsonResponse(addUser(data.username, data.password, data.role, data.userCode));
    if (action === "deleteUser") return jsonResponse(deleteUser(data.username));
    if (action === "setUserCanPrint") return jsonResponse(setUserCanPrint(data.username, !!data.canPrint));
    if (action === "changeUserPassword") return jsonResponse(changeUserPassword(data.username, data.password));
    if (action === "setUserGoogleEmail") return jsonResponse(setUserGoogleEmail(data.username, data.email));
    if (action === "saveHotkeys") return jsonResponse(saveHotkeys(data.hotkeys));
    if (action === "saveCategories") return jsonResponse(saveCategories(data.categories));
    if (action === "saveCategoryColor") return jsonResponse(saveCategoryColor(data.category, data.color));

    if (action === "saveColdExtra") return jsonResponse(setColdExtra(data.value));
    if (action === "toggleColdPause") return jsonResponse(setColdPaused(data.paused));
    if (action === "toggleTeacherReservation") return jsonResponse(setTeacherReservationOpen(data.open));
    if (action === "toggleOpenDayReservation") return jsonResponse(setOpenDayReservationOpen(data.open));
    if (action === "savePauseReason") return jsonResponse(setPauseReason(data.target, data.reason));
    if (action === "savePushMessage") return jsonResponse(setPushMessage(data.text, data.sender, data.active));
    if (action === "saveKdsStatus") return jsonResponse(saveKdsStatusConfig(data.config));
    if (action === "saveStaffCards") return jsonResponse(saveStaffCards(data.cards));
    if (action === "getCardAccounts") return jsonResponse({ success: true, accounts: getCardAccounts(data.card) });

    if (action === "createWalletPass") return jsonResponse(createWalletPass(data.order));

    if (action === "createOrder" || action === "createUnpaidOrder" || action === "createReservedOrder") {
      if (action === "createUnpaidOrder") data.order.status = "UNPAID";
      if (action === "createReservedOrder") data.order.status = "RESERVED";
      return jsonResponse(createOrderLocked(data.order));
    }
    if (action === "confirmPayment") return jsonResponse(confirmPaymentStatus(data.orderNum));
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
    if (action === "saveOrderGuide") return jsonResponse(saveOrderGuide(data.mode, data.guide));
    if (action === "savePickupConfig") return jsonResponse(savePickupConfig(data.config));
    if (action === "saveAnnouncements") return jsonResponse(saveAnnouncements(data.config));

  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}
