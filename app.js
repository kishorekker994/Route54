/**
 * Route 54 Bistro — Full Stack App Logic
 * Connects to Node.js backend via Fetch & WebSockets
 */

const socket = io({
  auth: (cb) => {
    cb({ token: localStorage.getItem('r54_admin_token') });
  }
});

socket.on("connect_error", (err) => {
  console.log("Socket connection error:", err.message);
});

socket.on("connect", () => {
  console.log("Socket connected/reconnected");
  if (isAdminLoggedIn) {
    const urlParams = new URLSearchParams(window.location.search);
    const isCustomerUrl = urlParams.get('admin') !== '1';
    fetchInitialData(isCustomerUrl);
  }
});

// ============================================================
// NOTIFICATION SOUND (Web Audio API — no file needed)
// ============================================================
let _audioCtx = null;

function _getAudioCtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

// Unlock AudioContext on first user interaction (browser autoplay policy)
document.addEventListener('click',      () => _getAudioCtx(), { once: true });
document.addEventListener('touchstart', () => _getAudioCtx(), { once: true });

/**
 * Keep the AudioContext alive by scheduling a silent oscillator every 20s.
 * Without this, browsers suspend it after ~10 min of inactivity.
 */
function _keepAudioContextAlive() {
  try {
    const ctx = _getAudioCtx();
    // Resume if suspended (e.g. after long inactivity)
    if (ctx.state === 'suspended') ctx.resume();
    // Schedule a silent 0-gain node to prevent suspension
    const silent = ctx.createOscillator();
    const silentGain = ctx.createGain();
    silentGain.gain.setValueAtTime(0, ctx.currentTime);
    silent.connect(silentGain);
    silentGain.connect(ctx.destination);
    silent.start(ctx.currentTime);
    silent.stop(ctx.currentTime + 0.001);
  } catch (e) { /* ignore */ }
}
// Ping every 20 seconds to prevent AudioContext suspension
setInterval(_keepAudioContextAlive, 20000);

/** Show the one-time sound unlock banner */
function _showSoundUnlockBanner() {
  // Only show if AudioContext is not yet unlocked
  const banner = document.getElementById('soundUnlockBanner');
  if (!banner) return;
  if (_audioCtx && _audioCtx.state === 'running') {
    banner.style.display = 'none'; // Already unlocked
  } else {
    banner.style.display = 'block';
  }
}

/** Called when admin taps the banner — unlocks audio and hides banner */
function unlockAudioAndHide() {
  _getAudioCtx(); // This user gesture unlocks the AudioContext
  const banner = document.getElementById('soundUnlockBanner');
  if (banner) banner.style.display = 'none';
  showToast('🔔 Sound alerts enabled!', 'success');
}

/**
 * Plays an ascending 3-note chime (E5 → G#5 → B5) for new QR orders.
/**
 * Plays a LOUD ascending 3-note chime that repeats for ~5 seconds.
 * E5 → G#5 → B5 (major triad), looped 5× with short pauses.
 */
function playOrderAlert() {
  try {
    const ctx  = _getAudioCtx();
    // Always resume first — critical after inactivity
    if (ctx.state === 'suspended') ctx.resume();
    const now  = ctx.currentTime;

    const notes      = [659.25, 830.61, 987.77]; // E5, G#5, B5
    const noteDur    = 0.25;   // each note length
    const noteGap    = 0.08;   // gap between notes in one chime
    const chimeDur   = notes.length * (noteDur + noteGap); // ~0.99s per chime
    const pauseAfter = 0.55;   // rest between repeats
    const repeats    = 5;      // ~5 × (0.99 + 0.55) ≈ 7.7s — stops at 5s via stopTime
    const stopTime   = now + 5.0; // hard cut-off at 5 seconds

    // Master volume — loud but not distorted
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.85, now);
    masterGain.connect(ctx.destination);

    for (let rep = 0; rep < repeats; rep++) {
      const repOffset = now + rep * (chimeDur + pauseAfter);
      if (repOffset >= stopTime) break; // don't schedule past 5s

      notes.forEach((freq, i) => {
        const t = repOffset + i * (noteDur + noteGap);
        if (t >= stopTime) return;

        // Primary sine tone
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t);

        // Triangle wave adds presence without harshness
        const osc2 = ctx.createOscillator();
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(freq, t);

        // Harmonic octave (sine, softer)
        const osc3 = ctx.createOscillator();
        osc3.type = 'sine';
        osc3.frequency.setValueAtTime(freq * 2, t);

        const g1 = ctx.createGain();
        const g2 = ctx.createGain();
        const g3 = ctx.createGain();

        const end = Math.min(t + noteDur, stopTime);

        // Fast attack, exponential decay
        g1.gain.setValueAtTime(0, t);
        g1.gain.linearRampToValueAtTime(0.70, t + 0.015);
        g1.gain.exponentialRampToValueAtTime(0.001, end);

        g2.gain.setValueAtTime(0, t);
        g2.gain.linearRampToValueAtTime(0.35, t + 0.015);
        g2.gain.exponentialRampToValueAtTime(0.001, end);

        g3.gain.setValueAtTime(0, t);
        g3.gain.linearRampToValueAtTime(0.20, t + 0.015);
        g3.gain.exponentialRampToValueAtTime(0.001, end);

        osc.connect(g1);  g1.connect(masterGain);
        osc2.connect(g2); g2.connect(masterGain);
        osc3.connect(g3); g3.connect(masterGain);

        osc.start(t);  osc.stop(end + 0.02);
        osc2.start(t); osc2.stop(end + 0.02);
        osc3.start(t); osc3.stop(end + 0.02);
      });
    }
  } catch (err) {
    console.warn('playOrderAlert failed:', err);
  }
}

// ============================================================
// TAB-CLOSE GUARD (Customer order tracking — Desktop + Mobile)
// ============================================================
let _tabLocked = false;

/** Desktop: show native browser dialog on close/refresh */
function _handleBeforeUnload(e) {
  e.preventDefault();
  e.returnValue = 'Your order is being prepared! Leave this page and you may miss status updates.';
  return e.returnValue;
}

/** Mobile: visibilitychange fires when user backgrounds/switches away.
 *  When they come back (visible again), show the comeback overlay. */
function _handleVisibilityChange() {
  if (!_tabLocked) return;
  if (document.visibilityState === 'visible') {
    // User came back — show the in-app warning overlay
    const overlay = document.getElementById('comebackOverlay');
    if (overlay) overlay.style.display = 'flex';
  }
}

/** Dismiss the comeback overlay */
function dismissComebackOverlay() {
  const overlay = document.getElementById('comebackOverlay');
  if (overlay) overlay.style.display = 'none';
}

/** Show the persistent "stay on page" banner in the confirm view */
function _showStayBanner() {
  const banner = document.getElementById('stayBanner');
  if (banner) banner.style.display = 'flex';
}

function _hideStayBanner() {
  const banner = document.getElementById('stayBanner');
  if (banner) banner.style.display = 'none';
}

/** Call once order is placed — activates both desktop + mobile guards */
function lockTabForOrderTracking() {
  if (!_tabLocked) {
    // Desktop: native browser unload dialog
    window.addEventListener('beforeunload', _handleBeforeUnload);
    // Mobile: visibilitychange comeback overlay
    document.addEventListener('visibilitychange', _handleVisibilityChange);
    _tabLocked = true;
    _showStayBanner();
    console.log('[Route54] Tab locked — order tracking active.');
  }
}

/** Call when order reaches final state (closed/ready) */
function unlockTab() {
  if (_tabLocked) {
    window.removeEventListener('beforeunload', _handleBeforeUnload);
    document.removeEventListener('visibilitychange', _handleVisibilityChange);
    _tabLocked = false;
    _hideStayBanner();
    // Also dismiss comeback overlay if it was showing
    dismissComebackOverlay();
    console.log('[Route54] Tab unlocked — order complete.');
  }
}


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
let currentOrderId  = null;  // Track customer's active order for real-time status updates

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
  const urlParams = new URLSearchParams(window.location.search);
  const isCustomerUrl = urlParams.get('admin') !== '1';

  if (isCustomerUrl) {
    showView('viewName');
  } else {
    isAdminLoggedIn = localStorage.getItem('r54_admin_logged_in') === 'true';
    if (isAdminLoggedIn) {
      showView('viewAdmin');
    } else {
      showView('viewLogin');
    }
  }

  startAdminClock();
  startLiveTimers(); // Start the 1-second interval for all live timers

  // Fetch initial data
  await fetchInitialData(isCustomerUrl);
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
    timestamp:     Number(o.timestamp) || Date.now(),
    waitTime:      o.wait_time      ?? o.waitTime ?? 0,
    rejectReason:  o.reject_reason  ?? o.rejectReason ?? ''
  };
}

async function fetchInitialData(isCustomerUrl) {
  try {
    if (isCustomerUrl) {
      const menuRes = await fetch('/api/menu');
      if (menuRes.ok) APP_DATA.menu = await menuRes.json();
      
      const savedOrderId = localStorage.getItem('r54_current_order_id');
      if (savedOrderId) {
        try {
          const ordRes = await fetch(`/api/order/${savedOrderId}`);
          if (ordRes.ok) {
            const o = await ordRes.json();
            const order = normalizeOrder(o);
            
            if (order.date === getTodayStr()) {
              currentOrderId = order.id;
              customerName = order.customerName;
              
              document.getElementById('confirmOrderId').textContent = '#' + order.id;
              document.getElementById('confirmName').textContent = order.customerName;
              
              let payText = '❓ TBD';
              if (order.paymentMethod === 'cash') payText = '💵 Cash';
              else if (order.paymentMethod === 'upi') payText = '📱 UPI';
              else payText = '💳 Pay at Counter';
              
              document.getElementById('confirmPayment').textContent = payText;
              document.getElementById('confirmTotal').textContent = formatCurrency(order.total);
              
              const cw = document.getElementById('confirmWait');
              if (cw) {
                cw.setAttribute('data-time', order.timestamp);
                cw.textContent = '00:00';
              }
              
              resetOrderStatusPipeline();
              updateOrderStatusPipeline(order.status);
              lockTabForOrderTracking();
              showView('viewConfirm');
              return; // Skip viewName because we restored tracking
            } else {
              localStorage.removeItem('r54_current_order_id');
              localStorage.removeItem('r54_pending_order');
            }
          }
        } catch (e) { console.error('Tracking fetch error:', e); }
      }
    } else {
      const headers = { 'Authorization': localStorage.getItem('r54_admin_token') };
      const [menuRes, ordersRes, settingsRes] = await Promise.all([
        fetch('/api/menu', { headers }), 
        fetch('/api/orders', { headers }), 
        fetch('/api/settings', { headers })
      ]);
      
      if (ordersRes.status === 401) {
        console.error('Unauthorized! Logging out...');
        localStorage.removeItem('r54_admin_logged_in');
        localStorage.removeItem('r54_admin_token');
        isAdminLoggedIn = false;
        showView('viewLogin');
        return;
      }
      
      if (menuRes.ok) APP_DATA.menu = await menuRes.json();
      if (ordersRes.ok) {
        const raw = await ordersRes.json();
        APP_DATA.orders = raw.map(normalizeOrder);
      }
      if (settingsRes.ok) {
        const s = await settingsRes.json();
        if (Object.keys(s).length > 0) APP_DATA.settings = { ...APP_DATA.settings, ...s };
      }
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

  // If this is the customer's own order coming back with the real server-assigned ID,
  // update currentOrderId and the confirmation display
  if (localStorage.getItem('r54_pending_order') === 'true' && order.status === 'new' && currentOrderId === 'PENDING') {
    if (order.customerName === customerName) {
      currentOrderId = order.id;
      localStorage.setItem('r54_current_order_id', order.id);
      localStorage.removeItem('r54_pending_order');
      const confirmIdEl = document.getElementById('confirmOrderId');
      if (confirmIdEl) confirmIdEl.textContent = '#' + order.id;
    }
  }

  if (isAdminLoggedIn) {
    // Play chime only for QR-placed orders (status 'new'), not admin-placed ones
    if (order.status === 'new') {
      playOrderAlert();
    }
    showToast(`🛎️ New Order #${order.id} from ${order.customerName}!`, 'success', true);
    renderOrders();
  }
});

socket.on('order_updated', (data) => {
  const o = APP_DATA.orders.find(x => x.id === data.orderId);
  if (o) {
    o.status = data.status;
    if (data.waitTime !== undefined) o.waitTime = data.waitTime;
    if (data.reason !== undefined) o.rejectReason = data.reason;
    if (isAdminLoggedIn) renderOrders();
  }
  
  if (data.orderId === currentOrderId) {
    if (data.status === 'pending') {
      const cw = document.getElementById('confirmWait');
      if (cw) {
        cw.textContent = formatWaitTime(data.waitTime || 0);
        cw.classList.remove('live-timer-display');
        cw.removeAttribute('data-time');
      }
    }
    updateOrderStatusPipeline(data.status, data.reason);
    
    // Notifications for customer
    if (data.status === 'closed') {
      playOrderReadyVoice(data.orderId);
      fireLocalNotification('Your Order is Ready! 🎉', 'Please collect your food from the counter.');
    } else if (data.status === 'rejected') {
      fireLocalNotification('Order Rejected ❌', data.reason || 'Your order was rejected.');
    }
  }
});

socket.on('order_items_updated', ({ orderId, items }) => {
  const o = APP_DATA.orders.find(x => x.id === orderId);
  if (o) o.items = items;
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
  const views = ['viewLogin', 'viewAdmin', 'viewName', 'viewMenu', 'viewCheckout', 'viewConfirm'];
  views.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', id === viewId);
  });
  window.scrollTo?.(0, 0);

  if (viewId === 'viewName') {
    const urlParams = new URLSearchParams(window.location.search);
    const isCustomerUrl = urlParams.get('admin') !== '1';
    const backBtn = document.getElementById('btnNameBack');
    if (backBtn) backBtn.style.display = isCustomerUrl ? 'none' : 'block';
    const homeBtn = document.getElementById('btnNameHome');
    if (homeBtn) homeBtn.style.display = isCustomerUrl ? 'none' : 'block';
  }

  if (viewId === 'viewMenu') {
    const urlParams = new URLSearchParams(window.location.search);
    const isCustomerUrl = urlParams.get('admin') !== '1';
    const homeBtn = document.getElementById('btnMenuHome');
    if (homeBtn) homeBtn.style.display = isCustomerUrl ? 'none' : 'block';
  }

  if (viewId === 'viewCheckout') {
    const urlParams = new URLSearchParams(window.location.search);
    const isCustomerUrl = urlParams.get('admin') !== '1';
    
    const pc = document.getElementById('paymentCard');
    if (pc) pc.style.display = isCustomerUrl ? 'none' : 'block';
    
    const btn = document.getElementById('btnPlaceOrder');
    if (isCustomerUrl && btn) btn.disabled = false;

    const homeBtn = document.getElementById('btnCheckoutHome');
    if (homeBtn) homeBtn.style.display = isCustomerUrl ? 'none' : 'block';
  }

  if (viewId === 'viewAdmin') {
    if (isAdminLoggedIn) renderOrders();
  }
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

function showNameEntry() {
  document.getElementById('customerName').value = '';
  showView('viewName');
}

function newOrder() {
  customerName = '';
  cart = {};
  selectedPayment = null;
  document.getElementById('customerName').value = '';
  localStorage.removeItem('r54_current_order_id');
  localStorage.removeItem('r54_pending_order');
  
  const urlParams = new URLSearchParams(window.location.search);
  const isCustomerUrl = urlParams.get('admin') !== '1';

  if (isCustomerUrl) {
    showView('viewName');
  } else {
    showView('viewAdmin');
  }
  updateCartBar();
}

function getSubCategory(name) {
  name = name.toLowerCase();
  if (name.includes('burger')) return 'Burgers 🍔';
  if (name.includes('wrap')) return 'Wraps 🌯';
  if (name.includes('fries') || name.includes('fry')) return 'Fries 🍟';
  if (name.includes('chicken')) return 'Fried Chicken 🍗';
  if (name.includes('bbq') || name.includes('barbeque')) return 'BBQ 🍖';
  if (name.includes('chips') || name.includes('potato')) return 'Chips 🥔';
  if (name.includes('pizza')) return 'Pizza 🍕';
  if (name.includes('taco')) return 'Tacos 🌮';
  if (name.includes('salad')) return 'Salads 🥗';
  if (name.includes('dessert') || name.includes('ice cream')) return 'Desserts 🍨';
  if (name.includes('drink') || name.includes('cola') || name.includes('shake')) return 'Drinks 🥤';
  return 'Others 🍽️';
}

function filterMenu() {
  renderMenu('veg');
  renderMenu('nonveg');
}

function toggleMenuSection(id) {
  const el = document.getElementById(id);
  const icon = document.getElementById('icon-' + id);
  if (el.style.display === 'none') {
    el.style.display = 'grid';
    if (icon) icon.textContent = '▼';
  } else {
    el.style.display = 'none';
    if (icon) icon.textContent = '▶';
  }
}

function renderMenu(category) {
  const query = (document.getElementById('menuSearch')?.value || '').toLowerCase();
  const menu   = APP_DATA.menu.filter(i => i.category === category && i.name.toLowerCase().includes(query));
  const gridId = category === 'veg' ? 'menuVeg' : 'menuNonveg';
  const grid   = document.getElementById(gridId);
  if (!grid) return;

  if (menu.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="width: 100%;"><span class="empty-icon">😢</span><p>No items found</p></div>`;
    return;
  }

  const grouped = {};
  menu.forEach(item => {
    const sub = item.subCategory || getSubCategory(item.name);
    if (!grouped[sub]) grouped[sub] = [];
    grouped[sub].push(item);
  });

  grid.innerHTML = Object.keys(grouped).map(sub => {
    const subId = `section-${category}-${sub.replace(/[^a-zA-Z]/g, '')}`;
    return `
    <div class="menu-section" style="width:100%; margin-bottom: 16px;">
      <button class="menu-section-header" onclick="toggleMenuSection('${subId}')" style="width:100%; display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); padding:12px 16px; border-radius:8px; color:white; font-family:var(--font-display); font-size:20px; cursor:pointer; margin-bottom: 12px;">
        <span>${sub}</span>
        <span id="icon-${subId}">▼</span>
      </button>
      <div id="${subId}" class="menu-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap:12px;">
        ${grouped[sub].map(item => {
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
        }).join('')}
      </div>
    </div>`;
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
  const urlParams = new URLSearchParams(window.location.search);
  const isCustomerUrl = urlParams.get('admin') !== '1';

  if (isCustomerUrl) {
    if (Object.keys(cart).length === 0) { showToast('Cart is empty!', 'error'); return; }
    createOrder('unverified');
    return;
  }

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
    id: 'PENDING',  // Server will assign the real sequential ID
    customerName,
    items,
    total,
    paymentMethod,
    status: 'new',
    date: getTodayStr(),
    timestamp: Date.now(),
    waitTime: 0
  };

  // Emit over socket
  socket.emit('new_order', order);
  
  const urlParams = new URLSearchParams(window.location.search);
  const isCustomerUrl = urlParams.get('admin') !== '1';
  
  if (!isCustomerUrl && isAdminLoggedIn) {
    showToast('Order created!', 'success');
    showView('viewAdmin');
    cart = {};
    updateCartBar();
    return;
  }

  currentOrderId = 'PENDING';  // Server will replace with real sequential ID
  localStorage.setItem('r54_pending_order', 'true');
  
  // Lock tab so customer can't accidentally close while tracking order
  lockTabForOrderTracking();
  document.getElementById('confirmOrderId').textContent  = '...';  // Updated when server responds

  document.getElementById('confirmName').textContent     = order.customerName;
  let payText = '❓ TBD';
  if (paymentMethod === 'cash') payText = '💵 Cash';
  else if (paymentMethod === 'upi') payText = '📱 UPI';
  else payText = '💳 Pay at Counter';
  
  document.getElementById('confirmPayment').textContent  = payText;
  document.getElementById('confirmTotal').textContent    = formatCurrency(total);
  
  const cw = document.getElementById('confirmWait');
  cw.setAttribute('data-time', order.timestamp);
  cw.textContent = '00:00';

  cart = {};
  updateCartBar();
  showView('viewConfirm');
  // Reset status pipeline to initial state
  resetOrderStatusPipeline();
}

// ============================================================
// ORDER STATUS PIPELINE (Customer View)
// ============================================================
function resetOrderStatusPipeline() {
  const dots = ['pipeDotApprove', 'pipeDotCooking', 'pipeDotReady'];
  const lines = ['pipeLineApprove', 'pipeLineCooking', 'pipeLineReady'];
  dots.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('pipeline-dot--done', 'pipeline-dot--active'); }
  });
  lines.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('pipeline-line--active');
  });
  const titleEl = document.getElementById('confirmTitle');
  if (titleEl) { titleEl.textContent = 'ORDER PLACED!'; titleEl.style.color = ''; }
  const subEl = document.getElementById('confirmSub');
  if (subEl) subEl.textContent = 'We have received your order 🔥';
  const iconEl = document.getElementById('confirmIcon');
  if (iconEl) iconEl.textContent = '✅';
  const animEl = document.getElementById('confirmAnim');
  if (animEl) animEl.style.borderColor = '';
}

function updateOrderStatusPipeline(status, reason = '') {
  if (status === 'pending') {
    // Admin verified → Cooking
    const approveEl = document.getElementById('pipeDotApprove');
    if (approveEl) { approveEl.classList.add('pipeline-dot--done'); approveEl.textContent = '✅'; }
    document.getElementById('pipeLineApprove')?.classList.add('pipeline-line--active');
    const cookEl = document.getElementById('pipeDotCooking');
    if (cookEl) { cookEl.classList.add('pipeline-dot--active'); }
    document.getElementById('pipeLineCooking')?.classList.add('pipeline-line--active');
    // Update title
    const titleEl = document.getElementById('confirmTitle');
    if (titleEl) titleEl.textContent = 'COOKING NOW! 🍳';
    const subEl = document.getElementById('confirmSub');
    if (subEl) subEl.textContent = 'Admin approved your order – it\'s being cooked!';
    showToast('Your order is being cooked! 🍳', 'success');
  } else if (status === 'closed') {
    // Order done → Ready
    const approveEl = document.getElementById('pipeDotApprove');
    if (approveEl) { approveEl.classList.add('pipeline-dot--done'); approveEl.textContent = '✅'; }
    document.getElementById('pipeLineApprove')?.classList.add('pipeline-line--active');
    const cookEl = document.getElementById('pipeDotCooking');
    if (cookEl) { cookEl.classList.add('pipeline-dot--done'); cookEl.textContent = '✅'; }
    document.getElementById('pipeLineCooking')?.classList.add('pipeline-line--active');
    const readyEl = document.getElementById('pipeDotReady');
    if (readyEl) { readyEl.classList.add('pipeline-dot--done', 'pipeline-dot--ready'); readyEl.textContent = '🎉'; }
    document.getElementById('pipeLineReady')?.classList.add('pipeline-line--active');
    // Update title
    const titleEl = document.getElementById('confirmTitle');
    if (titleEl) titleEl.textContent = 'ORDER READY! 🎉';
    const subEl = document.getElementById('confirmSub');
    if (subEl) subEl.textContent = 'Your food is ready – please collect!';
    const iconEl = document.getElementById('confirmIcon');
    if (iconEl) iconEl.textContent = '🎉';
    showToast('🎉 Your order is READY! Please collect!', 'success', true);
    // Order is complete — safe to release the tab lock
    unlockTab();
  } else if (status === 'rejected') {
    const titleEl = document.getElementById('confirmTitle');
    if (titleEl) { titleEl.textContent = 'ORDER REJECTED ❌'; titleEl.style.color = 'var(--secondary)'; }
    const subEl = document.getElementById('confirmSub');
    if (subEl) subEl.textContent = reason ? `Reason: ${reason}` : 'Your order was rejected.';
    const iconEl = document.getElementById('confirmIcon');
    if (iconEl) iconEl.textContent = '❌';
    const animEl = document.getElementById('confirmAnim');
    if (animEl) animEl.style.borderColor = 'var(--secondary)';
    showToast('Your order was rejected ❌', 'error');
  }
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

async function adminLogin() {
  const pass = document.getElementById('adminPass').value;
  const errorEl = document.getElementById('loginError');
  errorEl.classList.add('hidden');
  errorEl.textContent = '';

  if (!pass) {
    errorEl.textContent = 'Enter password';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    const data = await res.json();
    if (res.ok) {
      isAdminLoggedIn = true;
      localStorage.setItem('r54_admin_logged_in', 'true');
      localStorage.setItem('r54_admin_token', data.token);
      
      socket.disconnect();
      socket.connect(); // reconnect with token
      
      await fetchInitialData(); // Re-fetch data now that we have a token
      
      showView('viewAdmin');
      showAdminTab('active');
      showToast('Welcome back! 🔥', 'success');
      // Show sound unlock banner so admin can tap once to enable audio
      _showSoundUnlockBanner();
    } else {
      errorEl.textContent = data.error || 'Incorrect Password';
      errorEl.classList.remove('hidden');
      document.getElementById('adminPass').value = '';
      document.getElementById('adminPass').focus();
    }
  } catch (err) {
    console.error("Login failed", err);
    errorEl.textContent = 'Server Error';
    errorEl.classList.remove('hidden');
  }
}

function logoutAdmin() {
  isAdminLoggedIn = false;
  localStorage.removeItem('r54_admin_logged_in');
  localStorage.removeItem('r54_admin_token');
  socket.disconnect();
  showView('viewLogin');
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
  // Active: 'new' (QR unverified) + 'pending' (cooking)
  // Sort ascending by sequential number (or timestamp) = FIFO queue, #001 first
  const active = APP_DATA.orders
    .filter(o => o.status === 'new' || o.status === 'pending')
    .sort((a, b) => {
      const na = parseInt(a.id) || 0;
      const nb = parseInt(b.id) || 0;
      return na !== nb ? na - nb : a.timestamp - b.timestamp;
    });

  // Closed: most recent first
  const closed = APP_DATA.orders
    .filter(o => o.status === 'closed' || o.status === 'rejected')
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 50);

  updateAdminStats(active, closed);

  // Active list
  const activeContainer = document.getElementById('activeOrdersList');
  if (activeContainer) {
    activeContainer.innerHTML = active.length === 0
      ? `<div class="empty-state"><span class="empty-icon">🕐</span><p>No active orders.</p></div>`
      : active.map(o => buildOrderHtml(o, false)).join('');
  }

  // Closed list
  const closedContainer = document.getElementById('closedOrdersList');
  if (closedContainer) {
    closedContainer.innerHTML = closed.length === 0
      ? `<div class="empty-state"><span class="empty-icon">📦</span><p>No closed orders yet.</p></div>`
      : closed.map(o => buildOrderHtml(o, true)).join('');
  }

  // Update badges
  document.getElementById('activeOrderCount').textContent = active.length;
  document.getElementById('pendingBadge').textContent     = active.length;

  // Closed count badge (nav button + section header)
  const closedBadgeEl   = document.getElementById('closedBadge');
  const closedCountEl   = document.getElementById('closedOrderCount');
  if (closedBadgeEl) closedBadgeEl.textContent = closed.length;
  if (closedCountEl) closedCountEl.textContent = closed.length;
}

function buildOrderHtml(order, isClosed) {
  const itemTags = order.items.map((i, idx) => {
    if (isClosed) return `<span class="order-item-tag ${i.delivered ? 'delivered' : ''}">${i.delivered ? '✅ ' : ''}${i.emoji} ${i.name} ×${i.qty}</span>`;
    return `<button class="order-item-tag ${i.delivered ? 'delivered' : ''}" onclick="toggleItemDelivery('${order.id}', ${idx})">${i.delivered ? '✅ ' : ''}${i.emoji} ${i.name} ×${i.qty}</button>`;
  }).join('');
  let payBadge = '';
  if (order.paymentMethod === 'cash') payBadge = `<span class="badge badge--cash">💵 CASH</span>`;
  else if (order.paymentMethod === 'upi') payBadge = `<span class="badge badge--upi">📱 UPI</span>`;
  else payBadge = `<span class="badge" style="background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2)">💳 AT COUNTER</span>`;
  
  let actions = '';
  let statusBadge = '';
  if (isClosed) {
    if (order.status === 'rejected') {
      statusBadge = `<span class="badge" style="background:var(--secondary)">❌ REJECTED</span>`;
      if (order.rejectReason) {
        actions = `<div style="color:var(--secondary); font-size:12px; margin-top:8px;">Reason: ${escHtml(order.rejectReason)}</div>`;
      }
    } else {
      statusBadge = `<span class="badge badge--done">✅ DONE</span>`;
    }
  } else if (order.status === 'new') {
    statusBadge = `<span class="badge badge--new">⚠️ NEW</span>`;
    actions = `
      <div style="display:flex; gap:8px;">
        <button class="btn-primary btn-sm" onclick="openRejectModal('${order.id}')" style="background:rgba(255,255,255,0.1)">REJECT ❌</button>
        <button class="btn-primary btn-sm" onclick="verifyOrder('${order.id}')" style="background:var(--secondary)">VERIFY & COOK</button>
      </div>`;
  } else {
    statusBadge = `<span class="badge badge--pending">⏳ COOKING</span>`;
    actions = `<button class="btn-primary btn-sm" onclick="closeOrder('${order.id}')">✅ DONE</button>`;
  }

  const waitDisplay = isClosed 
    ? (order.waitTime !== undefined ? `<span class="order-wait">⏱ Wait: ${formatWaitTime(order.waitTime)}</span>` : '')
    : `<span class="order-wait">⏱ <span class="live-timer-display" data-time="${order.timestamp}">00:00</span></span>`;

  return `
  <div class="order-card order-card--${isClosed ? 'closed' : 'pending'}">
    <div class="order-card__header">
      <div class="order-card__id-wrap">
        <span class="order-card__id">#${order.id}</span>
        <span class="order-card__customer">${escHtml(order.customerName)}</span>
        <span class="order-card__time">${formatTime(order.timestamp)}</span>
      </div>
      <div class="order-card__meta">
        ${statusBadge}
        ${payBadge}
      </div>
    </div>
    <div class="order-card__items">${itemTags}</div>
    <div class="order-card__footer">
      <div>
        <span class="order-total">${formatCurrency(order.total)}</span>
        ${waitDisplay}
      </div>
      ${actions}
    </div>
  </div>`;
}

function verifyOrder(orderId) {
  socket.emit('update_order_status', { orderId, status: 'pending' });
  const o = APP_DATA.orders.find(x => x.id === orderId);
  if (o) o.status = 'pending';
  showToast('Order moved to Cooking! 🍳', 'success');
  renderOrders();
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

function toggleItemDelivery(orderId, idx) {
  const o = APP_DATA.orders.find(x => x.id === orderId);
  if (!o) return;
  o.items[idx].delivered = !o.items[idx].delivered;
  socket.emit('update_order_items', { orderId, items: o.items });
  
  if (o.items.every(i => i.delivered)) {
    closeOrder(orderId);
  } else {
    renderOrders();
  }
}

function closeOrder(orderId) {
  const o = APP_DATA.orders.find(x => x.id === orderId);
  if (!o) return;
  
  const waitTime = Math.floor((Date.now() - o.timestamp) / 1000);
  socket.emit('update_order_status', { orderId, status: 'closed', waitTime });
  
  o.status = 'closed';
  o.waitTime = waitTime;
  
  playOrderReadyVoice(orderId);
  playDingSound();
  
  showToast('Order closed! ✅ Check Closed tab', 'success');
  renderOrders();
}

// ============================================================
// ADMIN: REJECT ORDER MODAL
// ============================================================
function openRejectModal(orderId) {
  document.getElementById('rejectOrderId').value = orderId;
  document.getElementById('rejectReason').value = '';
  document.getElementById('rejectModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('rejectReason').focus(), 100);
}

function closeRejectModal() {
  document.getElementById('rejectModal').classList.add('hidden');
  document.body.style.overflow = '';
}

function confirmRejectOrder() {
  const orderId = document.getElementById('rejectOrderId').value;
  const reason  = document.getElementById('rejectReason').value.trim();

  if (!orderId) { closeRejectModal(); return; }
  if (!reason) {
    showToast('Please enter a reason for rejection.', 'error');
    document.getElementById('rejectReason').focus();
    return;
  }

  socket.emit('update_order_status', { orderId, status: 'rejected', reason });

  const o = APP_DATA.orders.find(x => x.id === orderId);
  if (o) { o.status = 'rejected'; o.rejectReason = reason; }

  closeRejectModal();
  showToast(`Order #${orderId} rejected.`, 'error');
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
  const subCategory = document.getElementById('newItemSubCategory').value;

  if (!name)  { showToast('Enter item name', 'error'); return; }
  if (!priceStr || isNaN(+priceStr) || +priceStr <= 0) { showToast('Enter valid price', 'error'); return; }

  const item = { id: `c_${Date.now()}`, name, emoji, price: +priceStr, category, subCategory, available: true };
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
  let vegCount = 0;
  let nonvegCount = 0;
  orders.forEach(o => {
    o.items.forEach(i => {
      const m = APP_DATA.menu.find(x => x.id === i.id);
      if (m && m.category === 'veg') vegCount += i.qty;
      else if (m && m.category === 'nonveg') nonvegCount += i.qty;
    });
  });

  const totalItems = vegCount + nonvegCount;

  document.getElementById('rTotalOrders').textContent  = orders.length;
  document.getElementById('rRevenue').textContent      = formatCurrency(revenue);
  document.getElementById('rVegOrders').textContent    = vegCount;
  document.getElementById('rNonvegOrders').textContent = nonvegCount;

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
      : orders.map(o => {
          const waitStr = o.waitTime !== undefined ? `<span style="font-size:11px;color:var(--text-muted)">⏱ ${formatWaitTime(o.waitTime)}</span>` : '';
          return `
        <div class="report-order-row" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div style="display:flex; flex-direction:column;">
            <span class="report-order-id">${o.id}</span>
            ${waitStr}
          </div>
          <span class="report-order-name">${escHtml(o.customerName)}</span>
          <span class="report-order-pay">${o.paymentMethod === 'cash' ? '💵' : '📱'}</span>
          <span class="report-order-total">${formatCurrency(Number(o.total))}</span>
        </div>`;
      }).join('');
  }
}

function formatWaitTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function downloadReport() {
  const dateStr = document.getElementById('reportDate')?.value || getTodayStr();
  const orders  = APP_DATA.orders.filter(o => o.date === dateStr && o.status === 'closed');

  if (orders.length === 0) { showToast('No data to export!', 'error'); return; }

  const rows = [
    [`Route 54 Bistro – Sales Report – ${dateStr}`], [],
    ['Order ID', 'Customer', 'Items', 'Total (₹)', 'Payment', 'Time', 'Wait Time'],
    ...orders.map(o => [
      o.id, o.customerName,
      o.items.map(i => `${i.name} x${i.qty}`).join(' | '),
      o.total, o.paymentMethod, formatTime(o.timestamp),
      o.waitTime !== undefined ? formatWaitTime(o.waitTime) : '-'
    ]),
    [], ['', '', 'TOTAL', orders.reduce((s, o) => s + o.total, 0), '', '', ''],
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

function showToast(msg, type = 'success', persistent = false) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  const dismiss = () => toast.classList.remove('toast--show');
  if (persistent) {
    toast.innerHTML = `<span>${msg}</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'margin-left:12px; background:none; border:none; color:white; font-weight:bold; cursor:pointer; font-size:16px; line-height:1; opacity:0.8; padding:0 4px;';
    closeBtn.addEventListener('click', dismiss);
    toast.appendChild(closeBtn);
  } else {
    toast.textContent = msg;
  }
  toast.className = `toast toast--${type} toast--show`;
  clearTimeout(toast._t);
  if (!persistent) {
    toast._t = setTimeout(dismiss, 3200);
  }
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ============================================================
// VOICE & NOTIFICATIONS
// ============================================================
function playVoiceNotification(text) {
  if ('speechSynthesis' in window) {
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.volume = 1;
      utterance.rate = 1.15; // Brisk pace
      utterance.pitch = 1.2; // Slightly higher pitch for active tone
      
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        // Look for energetic voices like Samantha, Victoria, or Google US English
        const activeNames = ['samantha', 'victoria', 'google us english', 'alex'];
        const activeVoice = voices.find(v => v.lang.startsWith('en') && activeNames.some(name => v.name.toLowerCase().includes(name)));
        if (activeVoice) utterance.voice = activeVoice;
      }
      
      window._activeUtterance = utterance;
      window.speechSynthesis.speak(utterance);
    } catch(err) {
      console.error("Speech Synthesis Error:", err);
    }
  }
}

function playOrderReadyVoice(orderId) {
  if ('speechSynthesis' in window) {
    try {
      const getActiveVoice = () => {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
          const activeNames = ['samantha', 'victoria', 'google us english', 'alex'];
          return voices.find(v => v.lang.startsWith('en') && activeNames.some(name => v.name.toLowerCase().includes(name)));
        }
        return null;
      };

      const createUtterance = (text) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US';
        u.volume = 1.0;
        u.rate = 1.15; // Brisk, active pace
        u.pitch = 1.2; // Active tone
        const voice = getActiveVoice();
        if (voice) u.voice = voice;
        return u;
      };

      const u1 = createUtterance("Order number");
      const u2 = createUtterance(String(orderId));
      const u3 = createUtterance("is ready!");

      // Store globally to prevent garbage collection on Safari
      window._activeU1 = u1;
      window._activeU2 = u2;
      window._activeU3 = u3;

      u1.onend = () => {
        setTimeout(() => window.speechSynthesis.speak(u2), 500);
      };
      
      u2.onend = () => {
        setTimeout(() => window.speechSynthesis.speak(u3), 500);
      };

      window.speechSynthesis.speak(u1);
    } catch(err) {
      console.error("Speech Synthesis Error:", err);
    }
  }
}

function playDingSound() {
  try {
    // Short, simple beep sound in base64
    const audio = new Audio("data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU"+Array(100).join("A"));
    // Since base64 string for a real ding is too long to hardcode easily, 
    // let's use the Web Audio API for a guaranteed beep that requires no external assets:
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 1);
    osc.stop(ctx.currentTime + 1);
  } catch(e) {}
}

function enablePushNotifications() {
  const btn = document.getElementById('btnEnableNotifications');
  if (btn) btn.style.display = 'none';

  if (!window.isSecureContext) {
    alert("NOTICE: Native Push Notifications require a secure HTTPS connection. Since you are running locally on HTTP, native push is disabled. However, in-app sounds and alerts will still work!");
    return;
  }
  if (!('Notification' in window)) {
    alert("Notifications are not supported in this browser.");
    return;
  }
  try {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        showToast('Notifications enabled! 🎉', 'success');
      } else {
        alert('Notification permission denied by browser.');
      }
    }).catch(err => {
      alert('Push Error: ' + err.message);
    });
  } catch (err) {
    alert('Push Error: ' + err.message);
  }
}

function fireLocalNotification(title, body) {
  // Always play a sound for in-app awareness
  playDingSound();
  
  // Try native push if permitted
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: 'logo-app.png' });
  } else {
    // Fallback: Persistent loud UI alert if they don't have native push
    showToast(title + " - " + body, 'success', true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if ('Notification' in window && Notification.permission === 'granted') {
    const btn = document.getElementById('btnEnableNotifications');
    if (btn) btn.style.display = 'none';
  }
  
  // Pre-load speech synthesis voices to prevent inconsistent voice bug
  if ('speechSynthesis' in window) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
  }
});
