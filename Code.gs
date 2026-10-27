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
    usersSheet.appendRow(["Username", "Password", "Role", "UserCode"]);
    usersSheet.appendRow(["spaghetti", "123456", "Staff", "1"]);
    usersSheet.appendRow(["tl.li", "123456", "Admin", "2"]);
    usersSheet.appendRow(["ky.wong", "123456", "Admin", "3"]);
    usersSheet.appendRow(["ku", "123456", "Staff", "4"]);
  } else {
    const headers = usersSheet.getRange(1, 1, 1, 4).getValues()[0];
    if (!headers[3] || String(headers[3]).trim() === "") {
      usersSheet.getRange(1, 4).setValue("UserCode");
    }
  }
  return usersSheet;
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
      return { success: true, username: String(data[i][0]).trim(), role: String(data[i][2] || "Staff").trim(), userCode: String(data[i][3] || "1").trim() };
    }
  }
  return { success: false, error: "Invalid username or password" };
}

function addUser(username, password, role, userCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ensureUsersSheet(ss);
  usersSheet.appendRow([username, password, role || "Staff", userCode || "1"]);
  bumpVersion();
  return { success: true };
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
function getPushMessage() {
  const raw = PropertiesService.getScriptProperties().getProperty("PUSH_MESSAGE");
  if (!raw) return { active: false, text: "", sender: "", timestamp: 0 };
  try {
    const parsed = JSON.parse(raw);
    return {
      active: parsed.active === true,
      text: String(parsed.text || ""),
      sender: String(parsed.sender || ""),
      timestamp: Number(parsed.timestamp) || 0
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
      users.push({ username: String(usersData[i][0]), role: String(usersData[i][2] || "Staff"), userCode: String(usersData[i][3] || "1").trim() });
    }
  }

  const props = PropertiesService.getScriptProperties();
  let hotkeys = props.getProperty("REMARK_HOTKEYS") || "+ Less Ice, + No Sugar, + Oat Milk, + Extra Hot";

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

  // Active orders only (exclude CLEARED) for fast loading
  const ordersSheet = ss.getSheetByName("Orders Log");
  let orders = [];
  if (ordersSheet) {
    const ordersData = ordersSheet.getDataRange().getValues();
    for (let i = 1; i < ordersData.length; i++) {
      const row = ordersData[i];
      const status = String(row[9] || "").trim().toUpperCase();
      if (["UNPAID", "PENDING", "ASSIGNED", "READY", "RESERVED"].includes(status)) {
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
          qrTile: row[10] ? String(row[10]).trim() : ""
        });
      }
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
    categoryColors: getCategoryColors()
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
        qrTile: row[10] ? String(row[10]).trim() : ""
      });
      if (status !== "UNPAID") revenue += Number(row[8]) || 0;
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
    const sheet = ss.getSheetByName("Orders Log");
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

    let rawNote = String(order.customization || "").replace(/[\r\n]+/g, " ").trim();
    if (rawNote.startsWith("+") || rawNote.startsWith("=") || rawNote.startsWith("-")) rawNote = "'" + rawNote;

    const createdOrder = {
      orderNum: assignedOrderNum,
      orderTime: orderTime,
      pickupTime: pickupTime.replace(/^'/, ""),
      cashier: cashier,
      guestName: guestName,
      productName: order.productName,
      temp: order.temp,
      customization: rawNote.replace(/^'/, ""),
      price: Number(order.price) || 0,
      status: status,
      qrTile: qrTile
    };

    sheet.appendRow([
      createdOrder.orderNum, createdOrder.orderTime, pickupTime,
      createdOrder.cashier, createdOrder.guestName, createdOrder.productName,
      createdOrder.temp, rawNote, createdOrder.price, createdOrder.status, createdOrder.qrTile
    ]);

    // Bind QR tile if provided
    if (qrTile) {
      bindTileToOrder(qrTile, assignedOrderNum);
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
  const sheet = ss.getSheetByName("Orders Log");
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

// Clear an order from a scanned code. The scanner may read either:
//   1. the barcode on the guest's pre-order ticket -> encodes the ORDER number
//   2. the QR tile handed out at the counter       -> encodes the TILE number
// Both are resolved to the newest matching row, because order numbers repeat
// after X999 rolls back to X001.
function clearOrderByTile(scannedCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Orders Log");
  const data = sheet.getDataRange().getValues();
  const target = String(scannedCode).trim().replace(/^#/, "");
  const CLEARABLE = ["UNPAID", "PENDING", "ASSIGNED", "READY", "RESERVED"];

  // 1) QR tile: newest READY order bound to this tile
  for (let i = data.length - 1; i >= 1; i--) {
    const tile = data[i][10] ? String(data[i][10]).trim() : "";
    const status = String(data[i][9] || "").trim().toUpperCase();
    if (tile === target && status === "READY") {
      const orderNum = String(data[i][0]).trim();
      const rowTile = data[i][10] ? String(data[i][10]).trim() : "";
      sheet.getRange(i + 1, 10).setValue("CLEARED");
      if (rowTile) freeTile(rowTile);
      SpreadsheetApp.flush();
      bumpVersion();
      return { success: true, orderNum: orderNum, status: "CLEARED", via: "tile" };
    }
  }

  // 2) Guest's pre-order barcode: newest live order carrying this order number
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim() !== target) continue;
    const status = String(data[i][9] || "").trim().toUpperCase();
    if (CLEARABLE.indexOf(status) === -1) continue;
    const rowTile = data[i][10] ? String(data[i][10]).trim() : "";
    sheet.getRange(i + 1, 10).setValue("CLEARED");
    if (rowTile) freeTile(rowTile);
    SpreadsheetApp.flush();
    bumpVersion();
    return { success: true, orderNum: target, status: "CLEARED", via: "orderNum" };
  }

  return { success: false, error: "No matching order found for this code" };
}

function deleteOrder(orderNum) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Orders Log");
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
  if (foundIndex === -1) {
    const tilesSheet = ss.getSheetByName("QR Tiles");
    if (tilesSheet) {
      const tilesData = tilesSheet.getDataRange().getValues();
      let boundOrder = "";
      for (let i = 1; i < tilesData.length; i++) {
        if (String(tilesData[i][0]).trim() === code) {
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
    return { success: false, error: "Order not found", scannedCode: code, tileStatus: tileStatus };
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
      category: category
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

function doPost(e) {
  try {
    let contents = e.postData.contents;
    let data;
    try { data = JSON.parse(contents); } catch (err) { data = JSON.parse(decodeURIComponent(contents)); }
    const action = data.action;

    if (action === "login") return jsonResponse(authenticateUser(data.username, data.password));
    if (action === "addUser") return jsonResponse(addUser(data.username, data.password, data.role, data.userCode));
    if (action === "deleteUser") return jsonResponse(deleteUser(data.username));
    if (action === "saveHotkeys") return jsonResponse(saveHotkeys(data.hotkeys));
    if (action === "saveCategories") return jsonResponse(saveCategories(data.categories));
    if (action === "saveCategoryColor") return jsonResponse(saveCategoryColor(data.category, data.color));

    if (action === "saveColdExtra") return jsonResponse(setColdExtra(data.value));
    if (action === "toggleColdPause") return jsonResponse(setColdPaused(data.paused));
    if (action === "toggleTeacherReservation") return jsonResponse(setTeacherReservationOpen(data.open));
    if (action === "toggleOpenDayReservation") return jsonResponse(setOpenDayReservationOpen(data.open));
    if (action === "savePauseReason") return jsonResponse(setPauseReason(data.target, data.reason));
    if (action === "savePushMessage") return jsonResponse(setPushMessage(data.text, data.sender, data.active));

    if (action === "createWalletPass") return jsonResponse(createWalletPass(data.order));

    if (action === "createOrder" || action === "createUnpaidOrder" || action === "createReservedOrder") {
      if (action === "createUnpaidOrder") data.order.status = "UNPAID";
      if (action === "createReservedOrder") data.order.status = "RESERVED";
      return jsonResponse(createOrderLocked(data.order));
    }
    if (action === "confirmPayment") return jsonResponse(updateOrderStatus(data.orderNum, "PENDING"));
    if (action === "assignOrder") return jsonResponse(updateOrderStatus(data.orderNum, "ASSIGNED"));
    if (action === "markReady") return jsonResponse(updateOrderStatus(data.orderNum, "READY"));
    if (action === "clearOrder") return jsonResponse(updateOrderStatus(data.orderNum, "CLEARED"));
    if (action === "clearOrderByTile") return jsonResponse(clearOrderByTile(data.tileCode));
    if (action === "deleteOrder") return jsonResponse(deleteOrder(data.orderNum));

    if (action === "toggleMenuItem") return jsonResponse(toggleMenuItem(data.itemName, data.newStatus));
    if (action === "saveMenuItem") return jsonResponse(saveMenuItem(data.item));
    if (action === "addMenuItem") return jsonResponse(addMenuItem(data.item));
    if (action === "deleteMenuItem") return jsonResponse(deleteMenuItem(data.itemName));

    if (action === "addQRTile") return jsonResponse(addQRTile(data.tileCode));
    if (action === "deleteQRTile") return jsonResponse(deleteQRTile(data.tileCode));

  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}
