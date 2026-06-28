/**
 * Route54 Food Truck — Admin Panel Logic
 */

// ---- STATE ----
let isLoggedIn = false;
let qrFileData = null;    // Temp hold for preview before save

// ---- INIT ----
document.addEventListener('DOMContentLoaded', () => {
  // Set today's date on report date input
  const reportDate = document.getElementById('reportDate');
  if (reportDate) reportDate.value = DB.getTodayStr();

  // Load truck settings into form
  loadSettingsForm();

  // Start clock
  startClock();

  // Allow Enter on password field
  const passInput = document.getElementById('adminPass');
  if (passInput) passInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') adminLogin();
  });
});

// ---- CLOCK ----
function startClock() {
  const clock = document.getElementById('liveClock');
  if (!clock) return;
  function tick() {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  tick();
  setInterval(tick, 1000);
}

// ---- LOGIN ----
function adminLogin() {
  const pass     = document.getElementById('adminPass').value;
  const settings = DB.getSettings();

  if (!pass) {
    showToast('Please enter a password', 'error');
    return;
  }

  if (pass === settings.adminPassword) {
    isLoggedIn = true;
    document.getElementById('adminLoginOverlay').classList.add('hidden');
    document.getElementById('adminDashboard').classList.remove('hidden');
    showAdminSection('orders');
    showToast('Welcome back! 🔥', 'success');
  } else {
    showToast('Wrong password. Try again.', 'error');
    document.getElementById('adminPass').value = '';
    document.getElementById('adminPass').focus();
  }
}

function adminLogout() {
  isLoggedIn = false;
  document.getElementById('adminDashboard').classList.add('hidden');
  document.getElementById('adminLoginOverlay').classList.remove('hidden');
  document.getElementById('adminPass').value = '';
}

// ---- NAV ----
function showAdminSection(section) {
  const sections = ['orders', 'menu', 'reports', 'settings'];
  sections.forEach(s => {
    const sec = document.getElementById(`section${cap(s)}`);
    const btn = document.getElementById(`nav${cap(s)}`);
    if (sec) sec.classList.toggle('hidden', s !== section);
    if (btn) {
      btn.classList.toggle('active', s === section);
      btn.setAttribute('aria-pressed', String(s === section));
    }
  });

  // Refresh content
  if (section === 'orders')   renderOrders();
  if (section === 'menu')     renderMenuAdmin();
  if (section === 'reports')  generateReport();
  if (section === 'settings') loadSettingsForm();
}

function cap(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

// ---- ORDERS ----
function renderOrders() {
  const active  = DB.getActiveOrders().sort((a, b) => a.timestamp - b.timestamp);
  const closed  = DB.getClosedOrders().sort((a, b) => b.timestamp - a.timestamp).slice(0, 30);

  updateStats(active, closed);
  renderOrderList('activeOrdersList', active, false);
  renderOrderList('closedOrdersList', closed, true);

  document.getElementById('activeOrderCount').textContent = active.length;
  document.getElementById('pendingBadge').textContent     = active.length;
}

function updateStats(active, closed) {
  const settings   = DB.getSettings();
  const todayOrders = DB.getOrdersForDate(DB.getTodayStr());

  document.getElementById('statPending').textContent = active.length;
  document.getElementById('statDone').textContent    = closed.filter(o => o.date === DB.getTodayStr()).length;

  const revenue = todayOrders
    .filter(o => o.status === 'closed')
    .reduce((s, o) => s + o.total, 0);
  document.getElementById('statRevenue').textContent = DB.formatCurrency(revenue);

  const avgWait = active.length > 0
    ? `~${active.length * (settings.avgPrepTime || 5)} min`
    : '~0 min';
  document.getElementById('statWait').textContent = avgWait;
}

function renderOrderList(containerId, orders, isClosed) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (orders.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <span class="empty-icon">${isClosed ? '📦' : '🕐'}</span>
      <p>${isClosed ? 'No closed orders yet.' : 'No active orders. Waiting for customers...'}</p>
    </div>`;
    return;
  }

  container.innerHTML = orders.map(order => {
    const itemTags = order.items.map(i =>
      `<span class="order-item-tag">${i.emoji} ${i.name} ×${i.qty}</span>`
    ).join('');

    const payBadge = order.paymentMethod === 'cash'
      ? `<span class="badge badge--cash">💵 CASH</span>`
      : `<span class="badge badge--upi">📱 UPI</span>`;

    const waitInfo = isClosed ? '' : `
      <span class="order-wait">⏱ Wait: ~${order.waitTime || 5} min</span>
    `;

    const actions = isClosed
      ? ''
      : `<div class="order-card__actions">
           <button class="btn-primary btn-sm" onclick="closeOrder('${order.id}')">✅ DONE – CLOSE</button>
         </div>`;

    return `
    <div class="order-card order-card--${isClosed ? 'closed' : 'pending'}" id="order-${order.id}">
      <div class="order-card__header">
        <div class="order-card__id-wrap">
          <span class="order-card__id">${order.id}</span>
          <span class="order-card__customer">${escHtml(order.customerName)}</span>
          <span class="order-card__time">${DB.formatTime(order.timestamp)}</span>
        </div>
        <div class="order-card__meta">
          <span class="badge ${isClosed ? 'badge--done' : 'badge--pending'}">
            ${isClosed ? '✅ DONE' : '⏳ PENDING'}
          </span>
          ${payBadge}
        </div>
      </div>
      <div class="order-card__items">${itemTags}</div>
      <div class="order-card__footer">
        <div>
          <span class="order-total">${DB.formatCurrency(order.total)}</span>
          ${waitInfo}
        </div>
        ${actions}
      </div>
    </div>
    `;
  }).join('');
}

function closeOrder(orderId) {
  DB.updateOrder(orderId, { status: 'closed', closedAt: Date.now() });
  showToast('Order closed! ✅', 'success');
  renderOrders();
}

// ---- MENU ADMIN ----
function renderMenuAdmin() {
  const menu = DB.getMenu();
  const vegItems    = menu.filter(i => i.category === 'veg');
  const nonvegItems = menu.filter(i => i.category === 'nonveg');

  renderMenuAdminList('adminMenuVeg',    vegItems);
  renderMenuAdminList('adminMenuNonveg', nonvegItems);
}

function renderMenuAdminList(containerId, items) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (items.length === 0) {
    container.innerHTML = `<p class="empty-hint">No items yet. Add some above!</p>`;
    return;
  }

  container.innerHTML = items.map(item => `
    <div class="menu-admin-item ${!item.available ? 'unavailable' : ''}" id="menuItem-${item.id}">
      <span class="menu-admin-emoji">${item.emoji}</span>
      <div class="menu-admin-info">
        <div class="menu-admin-name">${escHtml(item.name)}</div>
        <div class="menu-admin-price">₹${item.price}</div>
      </div>
      <div class="menu-admin-actions">
        <div class="toggle-wrap">
          <span class="toggle-label">${item.available ? 'IN STOCK' : 'OUT'}</span>
          <input
            type="checkbox"
            class="toggle-input"
            id="toggle-${item.id}"
            ${item.available ? 'checked' : ''}
            onchange="toggleItemAvailability('${item.id}')"
          />
          <label class="toggle-track" for="toggle-${item.id}" aria-label="Toggle availability"></label>
        </div>
        <button class="btn-delete" onclick="deleteMenuItem('${item.id}')" aria-label="Delete ${item.name}">🗑</button>
      </div>
    </div>
  `).join('');
}

function toggleItemAvailability(itemId) {
  const menu = DB.getMenu();
  const idx  = menu.findIndex(i => i.id === itemId);
  if (idx !== -1) {
    menu[idx].available = !menu[idx].available;
    DB.saveMenu(menu);
    const label = document.querySelector(`#menuItem-${itemId} .toggle-label`);
    if (label) label.textContent = menu[idx].available ? 'IN STOCK' : 'OUT';
    const item = document.getElementById(`menuItem-${itemId}`);
    if (item) item.classList.toggle('unavailable', !menu[idx].available);
    showToast(
      menu[idx].available ? `${menu[idx].name} is back in stock! ✅` : `${menu[idx].name} marked unavailable`,
      menu[idx].available ? 'success' : 'error'
    );
  }
}

function addMenuItem() {
  const name     = document.getElementById('newItemName').value.trim();
  const priceStr = document.getElementById('newItemPrice').value.trim();
  const emoji    = document.getElementById('newItemEmoji').value.trim() || '🍽️';
  const category = document.getElementById('newItemCategory').value;

  if (!name)  { showToast('Enter item name', 'error'); return; }
  if (!priceStr || isNaN(Number(priceStr)) || Number(priceStr) <= 0) {
    showToast('Enter a valid price', 'error'); return;
  }

  const menu = DB.getMenu();
  const newItem = {
    id:        `custom_${Date.now()}`,
    name,
    emoji,
    price:     Number(priceStr),
    category,
    available: true,
  };

  menu.push(newItem);
  DB.saveMenu(menu);

  // Clear form
  document.getElementById('newItemName').value  = '';
  document.getElementById('newItemPrice').value = '';
  document.getElementById('newItemEmoji').value = '';

  renderMenuAdmin();
  showToast(`${emoji} ${name} added! 🎉`, 'success');
}

function deleteMenuItem(itemId) {
  if (!confirm('Delete this menu item?')) return;
  const menu = DB.getMenu().filter(i => i.id !== itemId);
  DB.saveMenu(menu);
  renderMenuAdmin();
  showToast('Item deleted.', 'error');
}

// ---- REPORTS ----
function generateReport() {
  const dateInput = document.getElementById('reportDate');
  const dateStr   = dateInput ? dateInput.value : DB.getTodayStr();
  const orders    = DB.getOrdersForDate(dateStr).filter(o => o.status === 'closed');

  const totalRevenue = orders.reduce((s, o) => s + o.total, 0);
  const vegCount     = orders.filter(o => o.items.some(i => {
    const m = DB.getMenu().find(m => m.id === i.id);
    return m && m.category === 'veg';
  })).length;
  const nonvegCount = orders.length - vegCount;

  document.getElementById('rTotalOrders').textContent  = orders.length;
  document.getElementById('rRevenue').textContent      = DB.formatCurrency(totalRevenue);
  document.getElementById('rVegOrders').textContent    = vegCount;
  document.getElementById('rNonvegOrders').textContent = nonvegCount;

  // Top items
  const itemCounts = {};
  orders.forEach(order => {
    order.items.forEach(item => {
      if (!itemCounts[item.name]) itemCounts[item.name] = { name: item.name, emoji: item.emoji, count: 0 };
      itemCounts[item.name].count += item.qty;
    });
  });

  const topItems = Object.values(itemCounts).sort((a, b) => b.count - a.count).slice(0, 5);
  const maxCount = topItems[0]?.count || 1;

  const topList = document.getElementById('topItemsList');
  if (topItems.length === 0) {
    topList.innerHTML = `<p class="empty-hint">No orders for this date yet.</p>`;
  } else {
    topList.innerHTML = topItems.map((item, i) => `
      <div class="top-item-row">
        <span class="top-item-rank">#${i + 1}</span>
        <span>${item.emoji}</span>
        <span class="top-item-name">${escHtml(item.name)}</span>
        <span class="top-item-count">${item.count}x</span>
      </div>
      <div class="top-item-bar" style="width:${Math.round((item.count / maxCount) * 100)}%; margin: 0 0 8px;"></div>
    `).join('');
  }

  // Order breakdown
  const reportList = document.getElementById('reportOrdersList');
  if (orders.length === 0) {
    reportList.innerHTML = `<p class="empty-hint">No closed orders for this date.</p>`;
  } else {
    reportList.innerHTML = orders.map(o => `
      <div class="report-order-row">
        <span class="report-order-id">${o.id}</span>
        <span class="report-order-name">${escHtml(o.customerName)}</span>
        <span class="report-order-pay">${o.paymentMethod === 'cash' ? '💵' : '📱'}</span>
        <span class="report-order-total">${DB.formatCurrency(o.total)}</span>
      </div>
    `).join('');
  }
}

function downloadReport() {
  const dateInput = document.getElementById('reportDate');
  const dateStr   = dateInput ? dateInput.value : DB.getTodayStr();
  const orders    = DB.getOrdersForDate(dateStr).filter(o => o.status === 'closed');
  const settings  = DB.getSettings();

  if (orders.length === 0) {
    showToast('No orders to export for this date.', 'error');
    return;
  }

  // Build CSV
  const rows = [
    [`Route54 Food Truck – Sales Report – ${dateStr}`],
    [],
    ['Order ID', 'Customer', 'Items', 'Total (₹)', 'Payment', 'Time'],
  ];

  orders.forEach(o => {
    const itemStr = o.items.map(i => `${i.name} x${i.qty}`).join(' | ');
    rows.push([o.id, o.customerName, itemStr, o.total, o.paymentMethod, DB.formatTime(o.timestamp)]);
  });

  rows.push([]);
  const totalRev = orders.reduce((s, o) => s + o.total, 0);
  rows.push(['', '', 'TOTAL', totalRev, '', '']);

  const csvContent = rows.map(r =>
    r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
  ).join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href     = url;
  link.download = `Route54_Sales_${dateStr}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast('Report downloaded! 📊', 'success');
}

// ---- SETTINGS ----
function loadSettingsForm() {
  const settings = DB.getSettings();

  const truckName  = document.getElementById('truckName');
  const upiId      = document.getElementById('upiId');
  const prepTime   = document.getElementById('avgPrepTime');

  if (truckName) truckName.value = settings.truckName  || 'Route54';
  if (upiId)     upiId.value     = settings.upiId       || '';
  if (prepTime)  prepTime.value  = settings.avgPrepTime  || 5;

  // Load existing QR
  const qr = DB.getQRCode();
  const qrPreviewImg = document.getElementById('qrPreviewImg');
  const qrPreviewPlaceholder = document.getElementById('qrPreviewPlaceholder');
  if (qr && qrPreviewImg && qrPreviewPlaceholder) {
    qrPreviewImg.src = qr;
    qrPreviewImg.classList.remove('hidden');
    qrPreviewPlaceholder.classList.add('hidden');
  }
}

function saveTruckSettings() {
  const settings     = DB.getSettings();
  settings.truckName  = document.getElementById('truckName').value.trim() || 'Route54';
  settings.upiId      = document.getElementById('upiId').value.trim();
  settings.avgPrepTime = parseInt(document.getElementById('avgPrepTime').value) || 5;

  const qrPass = document.getElementById('qrChangePass').value.trim();
  if (qrPass) settings.qrPassword = qrPass;

  DB.saveSettings(settings);
  showToast('Settings saved! ✅', 'success');
}

function previewQR(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showToast('Please select an image file.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = e => {
    qrFileData = e.target.result;
    const img = document.getElementById('qrPreviewImg');
    const ph  = document.getElementById('qrPreviewPlaceholder');
    if (img && ph) {
      img.src = qrFileData;
      img.classList.remove('hidden');
      ph.classList.add('hidden');
    }
  };
  reader.readAsDataURL(file);
}

function saveQRCode() {
  const passInput = document.getElementById('qrPassword');
  const pass      = passInput.value.trim();
  const settings  = DB.getSettings();

  if (!qrFileData) {
    showToast('Please select a QR image first.', 'error');
    return;
  }

  if (pass !== settings.qrPassword) {
    showToast('Wrong QR change password!', 'error');
    passInput.value = '';
    passInput.focus();
    return;
  }

  DB.saveQRCode(qrFileData);
  passInput.value = '';
  qrFileData = null;
  showToast('QR Code saved! 📱', 'success');
}

function changePassword() {
  const oldPass  = document.getElementById('oldPassword').value;
  const newPass  = document.getElementById('newPassword').value;
  const confPass = document.getElementById('confirmPassword').value;
  const settings = DB.getSettings();

  if (oldPass !== settings.adminPassword) {
    showToast('Current password is wrong!', 'error'); return;
  }
  if (newPass.length < 6) {
    showToast('New password must be at least 6 characters.', 'error'); return;
  }
  if (newPass !== confPass) {
    showToast('Passwords do not match!', 'error'); return;
  }

  settings.adminPassword = newPass;
  DB.saveSettings(settings);

  document.getElementById('oldPassword').value  = '';
  document.getElementById('newPassword').value  = '';
  document.getElementById('confirmPassword').value = '';

  showToast('Password updated! 🔑', 'success');
}

// ---- TOAST ----
function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast toast--${type} toast--show`;
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.classList.remove('toast--show');
  }, 3500);
}

// ---- UTILS ----
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Auto-refresh orders every 30 seconds
setInterval(() => {
  if (isLoggedIn) {
    const activeSection = document.getElementById('sectionOrders');
    if (activeSection && !activeSection.classList.contains('hidden')) {
      renderOrders();
    }
  }
}, 30000);
