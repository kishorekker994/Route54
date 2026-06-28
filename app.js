/**
 * Route 54 Bistro — Full Stack App Logic
 * Connects to Node.js backend via Fetch & WebSockets
 */

const socket = io();

// ---- GLOBAL STATE ----
let APP_DATA = {
  menu: [],
  orders: [],
  settings: {
    adminPassword: 'route54admin',
    qrPassword: 'qr54change',
    truckName: 'Route 54 Bistro',
    upiId: '',
  }
};

let customerName    = '';
let cart            = {};
let selectedPayment = null;
let currentCategory = 'veg';
let logoTapCount    = 0;
let logoTapTimer    = null;

let isAdminLoggedIn = false;
let qrFileData      = null;
let currentAdminTab = 'active';

// ============================================================
// INIT & DATA FETCH
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Setup inputs
  const reportDate = document.getElementById('reportDate');
  if (reportDate) reportDate.value = getTodayStr();

  const nameInput = document.getElementById('customerName');
  if (nameInput) {
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') startOrder(); });
  }
  const passInput = document.getElementById('adminPass');
  if (passInput) {
    passInput.addEventListener('keydown', e => { if (e.key === 'Enter') adminLogin(); });
  }

  // Start UI
  showView('viewLanding');
  startAdminClock();
  startLiveTimers(); // Start the 1-second interval for all live timers

  // Fetch initial data
  await fetchInitialData();
});

// Normalize a DB row (snake_case) to camelCase for frontend use
function normalizeOrder(o) {
  return {
    id:            o.id,
    customerName:  o.customer_name  ?? o.customerName  ?? '',
    items:         typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []),
    total:         o.total          ?? 0,
    paymentMethod: o.payment_method ?? o.paymentMethod ?? 'cash',
    status:        o.status         ?? 'pending',
    date:          o.date           ?? '',
    timestamp:     o.timestamp      ?? Date.now(),
    waitTime:      o.wait_time      ?? o.waitTime ?? 0,
  };
}

async function fetchInitialData() {
  try {
    const [menuRes, ordersRes, settingsRes] = await Promise.all([
      fetch('/api/menu'), fetch('/api/orders'), fetch('/api/settings')
    ]);
    if (menuRes.ok) APP_DATA.menu = await menuRes.json();
    if (ordersRes.ok) {
      const raw = await ordersRes.json();
      APP_DATA.orders = raw.map(normalizeOrder);
    }
    if (settingsRes.ok) {
      const s = await settingsRes.json();
      if (Object.keys(s).length > 0) APP_DATA.settings = { ...APP_DATA.settings, ...s };
    }
  } catch (err) {
    console.error("Fetch failed (maybe running static without backend).", err);
  }
  
  if (isAdminLoggedIn) {
    renderOrders();
    if (currentAdminTab === 'menu') renderMenuAdmin();
  }
}

// ============================================================
// SOCKET LISTENERS (REAL-TIME)
// ============================================================
socket.on('order_added', (order) => {
  APP_DATA.orders.unshift(normalizeOrder(order));
  if (isAdminLoggedIn) renderOrders();
});

socket.on('order_updated', ({ orderId, status }) => {
  const o = APP_DATA.orders.find(x => x.id === orderId);
  if (o) o.status = status;
  if (isAdminLoggedIn) renderOrders();
});

socket.on('menu_updated', (item) => {
  const m = APP_DATA.menu.find(x => x.id === item.id);
  if (m) m.available = item.available;
  // Re-render customer menu if they are looking at it
  renderMenu('veg'); renderMenu('nonveg');
  if (isAdminLoggedIn && currentAdminTab === 'menu') renderMenuAdmin();
});

socket.on('menu_added', (item) => {
  APP_DATA.menu.push(item);
  if (isAdminLoggedIn && currentAdminTab === 'menu') renderMenuAdmin();
});

socket.on('menu_deleted', (itemId) => {
  APP_DATA.menu = APP_DATA.menu.filter(x => x.id !== itemId);
  if (isAdminLoggedIn && currentAdminTab === 'menu') renderMenuAdmin();
});

// ============================================================
// VIEW SYSTEM
// ============================================================
function showView(viewId) {
  const views = ['viewLanding', 'viewMenu', 'viewCheckout', 'viewConfirm'];
  views.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', id === viewId);
  });
  window.scrollTo?.(0, 0);
}

// ============================================================
// CUSTOMER ORDERING LOGIC
// ============================================================
function startOrder() {
  const input = document.getElementById('customerName');
  const name  = input.value.trim();

  if (!name) {
    input.style.borderColor = 'var(--secondary)';
    input.style.boxShadow   = 'var(--glow-secondary)';
    input.focus();
    setTimeout(() => {
      input.style.borderColor = ''; input.style.boxShadow = '';
    }, 1200);
    showToast('Please enter your name! 👋', 'error');
    return;
  }

  customerName = name;
  cart = {};

  document.getElementById('greetName').textContent = name.split(' ')[0];
  renderMenu('veg');
  renderMenu('nonveg');
  showView('viewMenu');
  updateCartBar();
}

function newOrder() {
  customerName = '';
  cart = {};
  selectedPayment = null;
  document.getElementById('customerName').value = '';
  showView('viewLanding');
  updateCartBar();
}

function renderMenu(category) {
  const menu   = APP_DATA.menu.filter(i => i.category === category);
  const gridId = category === 'veg' ? 'menuVeg' : 'menuNonveg';
  const grid   = document.getElementById(gridId);
  if (!grid) return;

  if (menu.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><span class="empty-icon">😢</span><p>No items in this category</p></div>`;
    return;
  }

  grid.innerHTML = menu.map(item => {
    const qty = cart[item.id]?.qty || 0;
    return `
    <article class="menu-item-card ${!item.available ? 'unavailable' : ''}" id="card-${item.id}">
      <div class="menu-item-emoji">${item.emoji}</div>
      <div class="menu-item-name">${item.name}</div>
      <div class="menu-item-price">₹${item.price}</div>
      ${!item.available ? '<span class="item-unavailable-tag">UNAVAILABLE</span>' : ''}
      <div class="qty-controls">
        <button class="qty-btn" onclick="changeQty('${item.id}',-1)" aria-label="Remove">−</button>
        <span class="qty-display" id="qtyDisplay-${item.id}">${qty}</span>
        <button class="qty-btn" onclick="changeQty('${item.id}',1)"  aria-label="Add">+</button>
      </div>
      <button class="add-to-cart-btn" onclick="addToCart('${item.id}')" ${!item.available ? 'disabled' : ''}>
        ${qty > 0 ? 'IN CART ✓' : 'ADD TO ORDER'}
      </button>
    </article>`;
  }).join('');
}

function changeQty(itemId, delta) {
  const item = APP_DATA.menu.find(i => i.id === itemId);
  if (!item) return;

  if (!cart[itemId]) cart[itemId] = { item, qty: 0 };
  cart[itemId].qty = Math.max(0, cart[itemId].qty + delta);
  if (cart[itemId].qty === 0) delete cart[itemId];

  const qtyEl = document.getElementById(`qtyDisplay-${itemId}`);
  if (qtyEl) qtyEl.textContent = cart[itemId]?.qty || 0;

  const addBtn = document.querySelector(`#card-${itemId} .add-to-cart-btn`);
  if (addBtn) addBtn.textContent = (cart[itemId]?.qty || 0) > 0 ? 'IN CART ✓' : 'ADD TO ORDER';

  updateCartBar();
}

function addToCart(itemId) {
  const item = APP_DATA.menu.find(i => i.id === itemId);
  if (!item || !item.available) return;

  if (!cart[itemId]) cart[itemId] = { item, qty: 0 };
  cart[itemId].qty += 1;

  const qtyEl = document.getElementById(`qtyDisplay-${itemId}`);
  if (qtyEl) qtyEl.textContent = cart[itemId].qty;

  const addBtn = document.querySelector(`#card-${itemId} .add-to-cart-btn`);
  if (addBtn) addBtn.textContent = 'IN CART ✓';

  const card = document.getElementById(`card-${itemId}`);
  if (card) {
    card.style.transform = 'scale(1.04)';
    setTimeout(() => { card.style.transform = ''; }, 180);
  }

  updateCartBar();
}

function switchCategory(cat) {
  currentCategory = cat;
  const tabVeg     = document.getElementById('tabVeg');
  const tabNonveg  = document.getElementById('tabNonveg');
  const menuVeg    = document.getElementById('menuVeg');
  const menuNonveg = document.getElementById('menuNonveg');

  if (cat === 'veg') {
    tabVeg.classList.add('active');    tabVeg.setAttribute('aria-selected', 'true');
    tabNonveg.classList.remove('active'); tabNonveg.setAttribute('aria-selected', 'false');
    menuVeg.classList.remove('hidden');
    menuNonveg.classList.add('hidden');
  } else {
    tabNonveg.classList.add('active'); tabNonveg.setAttribute('aria-selected', 'true');
    tabVeg.classList.remove('active'); tabVeg.setAttribute('aria-selected', 'false');
    menuNonveg.classList.remove('hidden');
    menuVeg.classList.add('hidden');
  }
}

function updateCartBar() {
  const cartBar = document.getElementById('cartBar');
  const items   = Object.values(cart);
  const count   = items.reduce((s, c) => s + c.qty, 0);
  const total   = items.reduce((s, c) => s + c.item.price * c.qty, 0);

  document.getElementById('cartCountBadge').textContent = count;
  document.getElementById('cartBarTotal').textContent   = formatCurrency(total);

  if (count > 0) cartBar.classList.remove('hidden');
  else           cartBar.classList.add('hidden');
}

function goToCheckout() {
  if (Object.keys(cart).length === 0) { showToast('Cart is empty!', 'error'); return; }
  
  const items = Object.values(cart);
  document.getElementById('cartList').innerHTML = items.map(({ item, qty }) => `
    <div class="cart-item">
      <span class="cart-item__emoji">${item.emoji}</span>
      <div class="cart-item__info">
        <div class="cart-item__name">${item.name}</div>
        <div class="cart-item__unit">₹${item.price} each</div>
      </div>
      <div class="cart-item__qty">× ${qty}</div>
      <div class="cart-item__price">${formatCurrency(item.price * qty)}</div>
    </div>
  `).join('');

  const total = items.reduce((s, c) => s + c.item.price * c.qty, 0);
  document.getElementById('summaryCount').textContent      = items.reduce((s, c) => s + c.qty, 0);
  document.getElementById('summaryGrandTotal').textContent = formatCurrency(total);

  selectedPayment = null;
  document.getElementById('btnCash').classList.remove('selected');
  document.getElementById('btnUpi').classList.remove('selected');
  document.getElementById('btnCash').setAttribute('aria-pressed', 'false');
  document.getElementById('btnUpi').setAttribute('aria-pressed', 'false');
  document.getElementById('btnPlaceOrder').disabled = true;
  showView('viewCheckout');
}

function selectPayment(type) {
  selectedPayment = type;
  document.getElementById('btnCash').classList.toggle('selected', type === 'cash');
  document.getElementById('btnUpi').classList.toggle('selected', type === 'upi');
  document.getElementById('btnCash').setAttribute('aria-pressed', String(type === 'cash'));
  document.getElementById('btnUpi').setAttribute('aria-pressed',  String(type === 'upi'));
  document.getElementById('btnPlaceOrder').disabled = false;
}

function placeOrder() {
  if (!selectedPayment) { showToast('Choose a payment method!', 'error'); return; }
  if (Object.keys(cart).length === 0) { showToast('Cart is empty!', 'error'); return; }
  if (selectedPayment === 'upi') { openUpiModal(); return; }
  createOrder('cash');
}

function openUpiModal() {
  const total  = Object.values(cart).reduce((s, c) => s + c.item.price * c.qty, 0);
  const qrCode = localStorage.getItem('r54_qr_code'); // Keep QR local for simplicity or fetch if needed
  const qrImg  = document.getElementById('qrImage');
  const qrPh   = document.getElementById('qrPlaceholder');

  document.getElementById('upiAmount').textContent = formatCurrency(total);

  if (qrCode) {
    qrImg.src = qrCode;
    qrImg.classList.remove('hidden');
    qrPh.classList.add('hidden');
  } else {
    qrImg.classList.add('hidden');
    qrPh.classList.remove('hidden');
  }

  document.getElementById('upiModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeUpiModal() {
  document.getElementById('upiModal').classList.add('hidden');
  document.body.style.overflow = '';
}

function confirmUpiPayment() {
  closeUpiModal();
  createOrder('upi');
}

function createOrder(paymentMethod) {
  const items = Object.values(cart).map(({ item, qty }) => ({
    id: item.id, name: item.name, emoji: item.emoji, price: item.price, qty,
  }));
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  
  const order = {
    id: 'R' + (Math.floor(Math.random() * 900) + 100),
    customerName,
    items,
    total,
    paymentMethod,
    status: 'pending',
    date: getTodayStr(),
    timestamp: Date.now(),
    waitTime: 0
  };

  // Emit over socket
  socket.emit('new_order', order);
  
  // Optimistic UI update
  APP_DATA.orders.unshift(order);

  document.getElementById('confirmOrderId').textContent  = order.id;
  document.getElementById('confirmName').textContent     = order.customerName;
  document.getElementById('confirmPayment').textContent  = paymentMethod === 'cash' ? '💵 Cash' : '📱 UPI';
  document.getElementById('confirmTotal').textContent    = formatCurrency(total);
  
  const cw = document.getElementById('confirmWait');
  cw.setAttribute('data-time', order.timestamp);
  cw.textContent = '00:00';

  cart = {};
  updateCartBar();
  showView('viewConfirm');
}

// ============================================================
// LIVE TIMERS
// ============================================================
function startLiveTimers() {
  setInterval(() => {
    const timerElements = document.querySelectorAll('.live-timer-display');
    const now = Date.now();
    timerElements.forEach(el => {
      const ts = parseInt(el.getAttribute('data-time'), 10);
      if (ts) {
        const diffMs = now - ts;
        const totalSecs = Math.floor(diffMs / 1000);
        const m = Math.floor(totalSecs / 60).toString().padStart(2, '0');
        const s = (totalSecs % 60).toString().padStart(2, '0');
        el.textContent = `${m}:${s}`;
        
        // Color coding based on time
        if (totalSecs > 600) { // >10 mins
          el.style.color = 'var(--primary)'; // red
          el.style.textShadow = 'var(--glow-primary)';
        } else if (totalSecs > 300) { // >5 mins
          el.style.color = '#ffaa00'; // orange
          el.style.textShadow = '0 0 8px rgba(255,170,0,0.5)';
        }
      }
    });
  }, 1000);
}


// ============================================================
// STAFF ACCESS (ADMIN)
// ============================================================
function handleLogoTap() {
  logoTapCount++;
  clearTimeout(logoTapTimer);

  const hint = document.getElementById('staffTapHint');
  if (hint && logoTapCount < 7) {
    hint.textContent = `${7 - logoTapCount} more...`;
  }

  if (logoTapCount >= 7) {
    logoTapCount = 0;
    if (hint) hint.textContent = '';
    openStaffModal();
    return;
  }

  logoTapTimer = setTimeout(() => {
    logoTapCount = 0;
    if (hint) hint.textContent = '';
  }, 4000);
}

function openStaffModal() {
  document.getElementById('adminOverlay').classList.remove('hidden');
  document.getElementById('adminLoginScreen').classList.remove('hidden');
  document.getElementById('adminDashboard').classList.add('hidden');
  document.getElementById('adminPass').value = '';
  setTimeout(() => document.getElementById('adminPass').focus(), 200);
}

function closeAdminOverlay() {
  document.getElementById('adminOverlay').classList.add('hidden');
  isAdminLoggedIn = false;
}

function adminLogin() {
  const pass = document.getElementById('adminPass').value;
  if (!pass) { showToast('Enter password', 'error'); return; }

  if (pass === APP_DATA.settings.adminPassword) {
    isAdminLoggedIn = true;
    document.getElementById('adminLoginScreen').classList.add('hidden');
    document.getElementById('adminDashboard').classList.remove('hidden');
    showAdminTab('active');
    showToast('Welcome back! 🔥', 'success');
  } else {
    showToast('Wrong password!', 'error');
    document.getElementById('adminPass').value = '';
    document.getElementById('adminPass').focus();
  }
}

function exitAdminMode() {
  isAdminLoggedIn = false;
  document.getElementById('adminOverlay').classList.add('hidden');
}

function showAdminTab(tab) {
  currentAdminTab = tab;
  const tabs = ['active', 'closed', 'menu', 'reports', 'settings'];
  tabs.forEach(t => {
    const tabEl = document.getElementById(`tab${cap(t)}`);
    const btnEl = document.getElementById(`anb${cap(t)}`);
    if (tabEl) tabEl.classList.toggle('hidden', t !== tab);
    if (btnEl) {
      btnEl.classList.toggle('active', t === tab);
      btnEl.setAttribute('aria-pressed', String(t === tab));
    }
  });

  if (tab === 'active' || tab === 'closed') renderOrders();
  if (tab === 'menu') renderMenuAdmin();
  if (tab === 'reports') {
    // Ensure date is always set before generating report
    const rd = document.getElementById('reportDate');
    if (rd && !rd.value) rd.value = getTodayStr();
    generateReport();
  }
  if (tab === 'settings') loadSettingsForm();
}

// ============================================================
// ADMIN: ORDERS
// ============================================================
function renderOrders() {
  const active = APP_DATA.orders.filter(o => o.status === 'pending').sort((a, b) => a.timestamp - b.timestamp);
  const closed = APP_DATA.orders.filter(o => o.status === 'closed').sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);

  updateAdminStats(active, closed);

  // Active
  const activeContainer = document.getElementById('activeOrdersList');
  if (activeContainer) {
    if (active.length === 0) {
      activeContainer.innerHTML = `<div class="empty-state"><span class="empty-icon">🕐</span><p>No active orders.</p></div>`;
    } else {
      activeContainer.innerHTML = active.map(o => buildOrderHtml(o, false)).join('');
    }
  }

  // Closed
  const closedContainer = document.getElementById('closedOrdersList');
  if (closedContainer) {
    if (closed.length === 0) {
      closedContainer.innerHTML = `<div class="empty-state"><span class="empty-icon">📦</span><p>No closed orders yet.</p></div>`;
    } else {
      closedContainer.innerHTML = closed.map(o => buildOrderHtml(o, true)).join('');
    }
  }

  document.getElementById('activeOrderCount').textContent = active.length;
  document.getElementById('pendingBadge').textContent = active.length;
}

function buildOrderHtml(order, isClosed) {
  const itemTags = order.items.map(i => `<span class="order-item-tag">${i.emoji} ${i.name} ×${i.qty}</span>`).join('');
  const payBadge = order.paymentMethod === 'cash'
    ? `<span class="badge badge--cash">💵 CASH</span>`
    : `<span class="badge badge--upi">📱 UPI</span>`;
  const actions = isClosed ? '' : `<button class="btn-primary btn-sm" onclick="closeOrder('${order.id}')">✅ DONE</button>`;

  return `
  <div class="order-card order-card--${isClosed ? 'closed' : 'pending'}">
    <div class="order-card__header">
      <div class="order-card__id-wrap">
        <span class="order-card__id">${order.id}</span>
        <span class="order-card__customer">${escHtml(order.customerName)}</span>
        <span class="order-card__time">${formatTime(order.timestamp)}</span>
      </div>
      <div class="order-card__meta">
        <span class="badge ${isClosed ? 'badge--done' : 'badge--pending'}">${isClosed ? '✅ DONE' : '⏳ PENDING'}</span>
        ${payBadge}
      </div>
    </div>
    <div class="order-card__items">${itemTags}</div>
    <div class="order-card__footer">
      <div>
        <span class="order-total">${formatCurrency(order.total)}</span>
        ${!isClosed ? `<span class="order-wait">⏱ <span class="live-timer-display" data-time="${order.timestamp}">00:00</span></span>` : ''}
      </div>
      ${actions}
    </div>
  </div>`;
}

function updateAdminStats(active, closed) {
  const todayStr = getTodayStr();
  const todayClosed = APP_DATA.orders.filter(o => o.status === 'closed' && o.date === todayStr);

  const elPending = document.getElementById('statPending');
  if (elPending) elPending.textContent = active.length;
  
  const elDone = document.getElementById('statDone');
  if (elDone) elDone.textContent = todayClosed.length;

  const revenue = todayClosed.reduce((s, o) => s + o.total, 0);
  const elRev = document.getElementById('statRevenue');
  if (elRev) elRev.textContent = formatCurrency(revenue);
}

function closeOrder(orderId) {
  // Emit to server
  socket.emit('update_order_status', { orderId, status: 'closed' });
  
  // Optimistic update in local state
  const o = APP_DATA.orders.find(x => x.id === orderId);
  if (o) o.status = 'closed';
  
  showToast('Order closed! ✅ Check Closed tab', 'success');
  // Re-render active tab to remove it, keeping current tab
  renderOrders();
}

// ============================================================
// ADMIN: MENU
// ============================================================
function renderMenuAdmin() {
  const menu = APP_DATA.menu;
  renderMenuAdminList('adminMenuVeg', menu.filter(i => i.category === 'veg'));
  renderMenuAdminList('adminMenuNonveg', menu.filter(i => i.category === 'nonveg'));
}

function renderMenuAdminList(containerId, items) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (items.length === 0) { el.innerHTML = `<p class="empty-hint">No items. Add above!</p>`; return; }

  el.innerHTML = items.map(item => `
    <div class="menu-admin-item ${!item.available ? 'unavailable' : ''}" id="menuItem-${item.id}">
      <span class="menu-admin-emoji">${item.emoji}</span>
      <div class="menu-admin-info">
        <div class="menu-admin-name">${escHtml(item.name)}</div>
        <div class="menu-admin-price">₹${item.price}</div>
      </div>
      <div class="menu-admin-actions">
        <div class="toggle-wrap">
          <span class="toggle-label">${item.available ? 'IN STOCK' : 'OUT'}</span>
          <input type="checkbox" class="toggle-input" id="toggle-${item.id}"
            ${item.available ? 'checked' : ''} onchange="toggleItem('${item.id}')" />
          <label class="toggle-track" for="toggle-${item.id}"></label>
        </div>
        <button class="btn-delete" onclick="deleteMenuItem('${item.id}')">🗑</button>
      </div>
    </div>`
  ).join('');
}

function toggleItem(itemId) {
  const idx = APP_DATA.menu.findIndex(i => i.id === itemId);
  if (idx !== -1) {
    const newVal = !APP_DATA.menu[idx].available;
    socket.emit('update_menu_item', { id: itemId, available: newVal });
    
    // Optimistic UI update for admin
    APP_DATA.menu[idx].available = newVal;
    const el = document.getElementById(`menuItem-${itemId}`);
    if (el) el.classList.toggle('unavailable', !newVal);
    const lbl = document.querySelector(`#menuItem-${itemId} .toggle-label`);
    if (lbl) lbl.textContent = newVal ? 'IN STOCK' : 'OUT';
  }
}

function addMenuItem() {
  const name     = document.getElementById('newItemName').value.trim();
  const priceStr = document.getElementById('newItemPrice').value.trim();
  const emoji    = document.getElementById('newItemEmoji').value.trim() || '🍽️';
  const category = document.getElementById('newItemCategory').value;

  if (!name)  { showToast('Enter item name', 'error'); return; }
  if (!priceStr || isNaN(+priceStr) || +priceStr <= 0) { showToast('Enter valid price', 'error'); return; }

  const item = { id: `c_${Date.now()}`, name, emoji, price: +priceStr, category, available: true };
  socket.emit('add_menu_item', item);

  document.getElementById('newItemName').value  = '';
  document.getElementById('newItemPrice').value = '';
  document.getElementById('newItemEmoji').value = '';

  showToast(`${emoji} ${name} added! 🎉`, 'success');
}

function deleteMenuItem(itemId) {
  if (!confirm('Delete this menu item?')) return;
  socket.emit('delete_menu_item', itemId);
}

// ============================================================
// ADMIN: REPORTS
// ============================================================
function generateReport() {
  const rdEl   = document.getElementById('reportDate');
  if (rdEl && !rdEl.value) rdEl.value = getTodayStr();
  const dateStr = rdEl?.value || getTodayStr();

  // Normalize order date — DB may store as 'YYYY-MM-DD' or as a timestamp number
  const normDate = (o) => {
    if (!o.date) return new Date(o.timestamp).toISOString().split('T')[0];
    if (/^\d+$/.test(String(o.date))) return new Date(Number(o.date)).toISOString().split('T')[0];
    return o.date;
  };

  const orders = APP_DATA.orders.filter(o => normDate(o) === dateStr && o.status === 'closed');

  const revenue  = orders.reduce((s, o) => s + Number(o.total), 0);
  const vegCount = orders.filter(o => o.items.some(i => APP_DATA.menu.find(m => m.id === i.id)?.category === 'veg')).length;

  document.getElementById('rTotalOrders').textContent  = orders.length;
  document.getElementById('rRevenue').textContent      = formatCurrency(revenue);
  document.getElementById('rVegOrders').textContent    = vegCount;
  document.getElementById('rNonvegOrders').textContent = orders.length - vegCount;

  // Top items
  const itemCounts = {};
  orders.forEach(o => o.items.forEach(i => {
    if (!itemCounts[i.name]) itemCounts[i.name] = { name: i.name, emoji: i.emoji || '🍽️', count: 0 };
    itemCounts[i.name].count += i.qty;
  }));
  const top  = Object.values(itemCounts).sort((a, b) => b.count - a.count).slice(0, 5);
  const maxC = top[0]?.count || 1;
  const topEl = document.getElementById('topItemsList');
  if (topEl) {
    topEl.innerHTML = top.length === 0
      ? `<p class="empty-hint">No orders for ${dateStr}.</p>`
      : top.map((item, i) => `
        <div class="top-item-row">
          <span class="top-item-rank">#${i+1}</span>
          <span>${item.emoji}</span>
          <span class="top-item-name">${escHtml(item.name)}</span>
          <span class="top-item-count">${item.count}x</span>
        </div>
        <div class="top-item-bar" style="width:${Math.round((item.count/maxC)*100)}%"></div>
      `).join('');
  }

  // Order breakdown list
  const listEl = document.getElementById('reportOrdersList');
  if (listEl) {
    listEl.innerHTML = orders.length === 0
      ? `<p class="empty-hint">No closed orders for ${dateStr}.</p>`
      : orders.map(o => `
        <div class="report-order-row">
          <span class="report-order-id">${o.id}</span>
          <span class="report-order-name">${escHtml(o.customerName)}</span>
          <span class="report-order-pay">${o.paymentMethod === 'cash' ? '💵' : '📱'}</span>
          <span class="report-order-total">${formatCurrency(Number(o.total))}</span>
        </div>`
      ).join('');
  }
}

function downloadReport() {
  const dateStr = document.getElementById('reportDate')?.value || getTodayStr();
  const orders  = APP_DATA.orders.filter(o => o.date === dateStr && o.status === 'closed');

  if (orders.length === 0) { showToast('No data to export!', 'error'); return; }

  const rows = [
    [`Route 54 Bistro – Sales Report – ${dateStr}`], [],
    ['Order ID', 'Customer', 'Items', 'Total (₹)', 'Payment', 'Time'],
    ...orders.map(o => [
      o.id, o.customerName,
      o.items.map(i => `${i.name} x${i.qty}`).join(' | '),
      o.total, o.paymentMethod, formatTime(o.timestamp)
    ]),
    [], ['', '', 'TOTAL', orders.reduce((s, o) => s + o.total, 0), '', ''],
  ];

  const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `Route54Bistro_${dateStr}.csv`;
  document.body.appendChild(link); link.click();
  document.body.removeChild(link); URL.revokeObjectURL(url);
}

// ============================================================
// ADMIN: SETTINGS
// ============================================================
function loadSettingsForm() {
  const s = APP_DATA.settings;
  const f = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  f('truckName', s.truckName || 'Route 54 Bistro');
  f('upiId', s.upiId || '');

  const qr = localStorage.getItem('r54_qr_code');
  const qrImg = document.getElementById('qrPreviewImg');
  const qrPh  = document.getElementById('qrPreviewPlaceholder');
  if (qr && qrImg && qrPh) { qrImg.src = qr; qrImg.classList.remove('hidden'); qrPh.classList.add('hidden'); }
}

function saveTruckSettings() {
  APP_DATA.settings.truckName = document.getElementById('truckName').value.trim() || 'Route 54 Bistro';
  APP_DATA.settings.upiId = document.getElementById('upiId').value.trim();
  // Here we would normally send to server to persist, for now just memory
  showToast('Settings saved! ✅', 'success');
}

function previewQR(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    qrFileData = e.target.result;
    const img = document.getElementById('qrPreviewImg');
    const ph  = document.getElementById('qrPreviewPlaceholder');
    if (img && ph) { img.src = qrFileData; img.classList.remove('hidden'); ph.classList.add('hidden'); }
  };
  reader.readAsDataURL(file);
}

function saveQRCode() {
  const pass = document.getElementById('qrPassword').value.trim();
  if (!qrFileData) { showToast('Select a QR image first.', 'error'); return; }
  if (pass !== APP_DATA.settings.qrPassword) { showToast('Wrong QR password!', 'error'); document.getElementById('qrPassword').value = ''; return; }
  
  localStorage.setItem('r54_qr_code', qrFileData);
  document.getElementById('qrPassword').value = '';
  qrFileData = null;
  showToast('QR Code saved! 📱', 'success');
}

function changePassword() {
  const oldPass  = document.getElementById('oldPassword').value;
  const newPass  = document.getElementById('newPassword').value;
  const confPass = document.getElementById('confirmPassword').value;

  if (oldPass !== APP_DATA.settings.adminPassword) { showToast('Wrong current password!', 'error'); return; }
  if (newPass.length < 6) { showToast('Min 6 characters needed.', 'error'); return; }
  if (newPass !== confPass) { showToast('Passwords do not match!', 'error'); return; }

  APP_DATA.settings.adminPassword = newPass;
  document.getElementById('oldPassword').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmPassword').value = '';
  showToast('Password updated! 🔑', 'success');
}

// ============================================================
// ADMIN CLOCK & UTILS
// ============================================================
function startAdminClock() {
  const tick = () => {
    const el = document.getElementById('adminClock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  };
  tick();
  setInterval(tick, 1000);
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function formatCurrency(amount) {
  return `₹${amount.toLocaleString('en-IN')}`;
}

function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast toast--${type} toast--show`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('toast--show'), 3200);
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
