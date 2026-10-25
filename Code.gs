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

// Ensure menu sheet has Category column (E)
function ensureMenuSheetColumns(sheet) {
  const headers = sheet.getRange(1, 1, 1, 5).getValues()[0];
  if (!headers[4] || String(headers[4]).trim() === "") {
    sheet.getRange(1, 5).setValue("Category");
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

  // Menu with category
  const summarySheet = ss.getSheetByName("Financial & Menu Summary");
  let menu = [];
  if (summarySheet) {
    ensureMenuSheetColumns(summarySheet);
    const menuData = summarySheet.getDataRange().getValues();
    for (let i = 1; i < menuData.length; i++) {
      const row = menuData[i];
      if (row[0]) {
        const status = String(row[3] || "Active").trim();
        menu.push({
          name: String(row[0]),
          tempOptions: String(row[1] || "Hot & Cold"),
          price: Number(row[2]) || 0,
          status: status,
          available: status.toLowerCase() === "active",
          category: String(row[4] || "Other").trim()
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
      if (["UNPAID", "PENDING", "READY", "RESERVED"].includes(status)) {
        orders.push({
          orderNum: String(row[0]).trim(),
          orderTime: row[1] ? String(row[1]) : "",
          pickupTime: row[2] ? String(row[2]) : "",
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
    version: getVersion()
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
    if (["UNPAID", "PENDING", "READY", "CLEARED", "RESERVED"].includes(status)) {
      orders.push({
        orderNum: String(row[0]).trim(),
        orderTime: row[1] ? String(row[1]) : "",
        pickupTime: row[2] ? String(row[2]) : "",
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
  let maxFound = prefixBase;
  for (let i = 1; i < ordersData.length; i++) {
    const num = parseInt(ordersData[i][0], 10);
    if (!isNaN(num) && num >= minRange && num <= maxRange && num > maxFound) maxFound = num;
  }
  return String(maxFound + 1);
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
    const pickupTime = order.pickupTime || "";
    const cashier = order.cashier || "Self-Order";
    const guestName = order.guestName || "Guest";
    const status = order.status || "PENDING";
    const qrTile = order.qrTile || "";

    let rawNote = String(order.customization || "").replace(/[\r\n]+/g, " ").trim();
    if (rawNote.startsWith("+") || rawNote.startsWith("=") || rawNote.startsWith("-")) rawNote = "'" + rawNote;

    const createdOrder = {
      orderNum: assignedOrderNum,
      orderTime: orderTime,
      pickupTime: pickupTime,
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
      createdOrder.orderNum, createdOrder.orderTime, createdOrder.pickupTime,
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

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(orderNum).trim()) {
      sheet.getRange(i + 1, 10).setValue(newStatus);
      const existingPickup = String(data[i][2] || "").trim();
      if (newStatus === "READY" && !existingPickup) {
        sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
      }
      // Free QR tile when order is cleared
      if (newStatus === "CLEARED") {
        const tile = data[i][10] ? String(data[i][10]).trim() : "";
        if (tile) freeTile(tile);
      }
      SpreadsheetApp.flush();
      bumpVersion();
      return { success: true, orderNum: orderNum, status: newStatus };
    }
  }
  return { success: false, error: "Order not found" };
}

// Clear order by scanning QR tile - finds the READY order bound to this tile
function clearOrderByTile(tileCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Orders Log");
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const tile = data[i][10] ? String(data[i][10]).trim() : "";
    const status = String(data[i][9] || "").trim().toUpperCase();
    if (tile === String(tileCode).trim() && status === "READY") {
      const orderNum = String(data[i][0]).trim();
      sheet.getRange(i + 1, 10).setValue("CLEARED");
      freeTile(tileCode);
      SpreadsheetApp.flush();
      bumpVersion();
      return { success: true, orderNum: orderNum, status: "CLEARED" };
    }
  }
  return { success: false, error: "No ready order found for this tile" };
}

function deleteOrder(orderNum) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Orders Log");
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(orderNum).trim()) {
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
  sheet.appendRow([item.name, item.tempOptions, item.price, item.status || "Active", item.category || "Other"]);
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
    return jsonResponse({ categories: getCategories() });
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

    if (action === "createOrder" || action === "createUnpaidOrder" || action === "createReservedOrder") {
      if (action === "createUnpaidOrder") data.order.status = "UNPAID";
      if (action === "createReservedOrder") data.order.status = "RESERVED";
      return jsonResponse(createOrderLocked(data.order));
    }
    if (action === "confirmPayment") return jsonResponse(updateOrderStatus(data.orderNum, "PENDING"));
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
