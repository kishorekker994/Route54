require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

// Security & In-memory store
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'route54admin';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'route54-admin-static-token';

let localMenu = [];
let localOrders = [];
let localSettings = { truckName: 'Route 54 Bistro', upiId: '' };
let orderCounter      = 0;       // Sequential order counter (persistent via DB)
let orderCounterMonth = '';      // YYYY-MM of the month the counter belongs to

/** Returns current month as 'YYYY-MM' */
function getYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const defaultMenu = [
  { id: 'v1', name: 'Veg Burger', emoji: '🍔', price: 100, category: 'veg', available: true },
  { id: 'v2', name: 'Veg Wrap', emoji: '🌯', price: 90, category: 'veg', available: true },
  { id: 'v3', name: 'Loaded Fries', emoji: '🍟', price: 80, category: 'veg', available: true },
  { id: 'n1', name: 'Chicken Burger', emoji: '🍔', price: 140, category: 'nonveg', available: true },
  { id: 'n2', name: 'Chicken Wrap', emoji: '🌯', price: 130, category: 'nonveg', available: true },
  { id: 'n3', name: 'Chicken Fries', emoji: '🍗', price: 120, category: 'nonveg', available: true }
];

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.warn("No DATABASE_URL provided. Using in-memory fallback.");
    localMenu = [...defaultMenu];
    orderCounter      = 0;
    orderCounterMonth = getYearMonth();
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS menu (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100), emoji VARCHAR(10), price INTEGER, category VARCHAR(50), available BOOLEAN);
      CREATE TABLE IF NOT EXISTS orders (id VARCHAR(50) PRIMARY KEY, customer_name VARCHAR(100), items JSONB, total INTEGER, payment_method VARCHAR(50), status VARCHAR(50), date VARCHAR(20), timestamp BIGINT, wait_time INTEGER);
      CREATE TABLE IF NOT EXISTS settings (key VARCHAR(50) PRIMARY KEY, value JSONB);
      CREATE TABLE IF NOT EXISTS counters (key VARCHAR(50) PRIMARY KEY, value TEXT DEFAULT '0');
    `);
    // Initialize order counter from DB
    await pool.query("INSERT INTO counters (key, value) VALUES ('order_seq', '0') ON CONFLICT (key) DO NOTHING");
    await pool.query("INSERT INTO counters (key, value) VALUES ('order_month', $1) ON CONFLICT (key) DO NOTHING", [getYearMonth()]);

    const cRes = await pool.query("SELECT value FROM counters WHERE key = 'order_seq'");
    const mRes = await pool.query("SELECT value FROM counters WHERE key = 'order_month'");
    orderCounter      = parseInt(cRes.rows[0]?.value ?? '0', 10);
    orderCounterMonth = mRes.rows[0]?.value ?? getYearMonth();

    // If the stored month is in the past, reset the counter now
    if (orderCounterMonth !== getYearMonth()) {
      orderCounter      = 0;
      orderCounterMonth = getYearMonth();
      await pool.query("UPDATE counters SET value = '0' WHERE key = 'order_seq'");
      await pool.query("UPDATE counters SET value = $1  WHERE key = 'order_month'", [orderCounterMonth]);
      console.log('[Route54] New month detected on startup — order counter reset to 0.');
    }

    const res = await pool.query('SELECT count(*) FROM menu');
    if (parseInt(res.rows[0].count) === 0) {
      for (const item of defaultMenu) {
        await pool.query('INSERT INTO menu (id, name, emoji, price, category, available) VALUES ($1, $2, $3, $4, $5, $6)', [item.id, item.name, item.emoji, item.price, item.category, item.available]);
      }
    }
    console.log(`Database initialized. Order counter: ${orderCounter} (Month: ${orderCounterMonth})`);
  } catch (err) {
    console.error("Database initialization failed:", err);
  }
}
initDB();

// AUTH MIDDLEWARE
function requireAuth(req, res, next) {
  const token = req.headers['authorization'];
  if (token === `Bearer ${ADMIN_TOKEN}` || token === ADMIN_TOKEN) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// API ROUTES
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ token: ADMIN_TOKEN, settings: localSettings });
  } else {
    res.status(401).json({ error: "Incorrect password" });
  }
});

app.get('/api/menu', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json(localMenu);
  try {
    const result = await pool.query('SELECT * FROM menu');
    res.json(result.rows);
  } catch (err) { res.status(500).json([]); }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json(localOrders.sort((a,b) => b.timestamp - a.timestamp));
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json([]); }
});

app.get('/api/settings', requireAuth, async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json(localSettings);
  try {
    const result = await pool.query("SELECT * FROM settings WHERE key = 'app_settings'");
    if (result.rows.length > 0) return res.json(result.rows[0].value);
    res.json({});
  } catch (err) { res.status(500).json({}); }
});

// WEBSOCKETS (Real-time sync)
function checkAdminSocket(socket) {
  const token = socket.handshake.auth.token;
  return token === ADMIN_TOKEN || token === `Bearer ${ADMIN_TOKEN}`;
}

io.on('connection', (socket) => {
  console.log('A client connected');
  
  socket.on('new_order', async (order) => {
    // ── Monthly reset: if month changed, start from #001 again ──
    const thisMonth = getYearMonth();
    if (thisMonth !== orderCounterMonth) {
      orderCounter      = 0;
      orderCounterMonth = thisMonth;
      console.log(`[Route54] New month (${thisMonth}) — order counter reset to 0.`);
      if (process.env.DATABASE_URL) {
        await pool.query("UPDATE counters SET value = '0' WHERE key = 'order_seq'").catch(() => {});
        await pool.query("UPDATE counters SET value = $1  WHERE key = 'order_month'", [thisMonth]).catch(() => {});
      }
    }

    // Assign sequential order number server-side
    orderCounter += 1;
    const seqId = String(orderCounter).padStart(3, '0');  // 001, 002, ...
    order.id = seqId;
    order.seqNum = orderCounter;
    console.log(`[Socket] Received new_order: #${order.id} (Customer: ${order.customerName}, Month: ${orderCounterMonth})`);
    if (process.env.DATABASE_URL) {
      try {
        // Persist updated counter
        await pool.query("UPDATE counters SET value = $1 WHERE key = 'order_seq'", [String(orderCounter)]);
        await pool.query('INSERT INTO orders (id, customer_name, items, total, payment_method, status, date, timestamp, wait_time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [order.id, order.customerName, JSON.stringify(order.items), order.total, order.paymentMethod, order.status, order.date, order.timestamp, order.waitTime]);
      } catch (err) { console.error("Failed to save order", err); }
    } else {
      localOrders.unshift(order);
    }
    console.log(`[Socket] Broadcasting order_added: #${order.id}`);
    io.emit('order_added', order);
  });

  socket.on('update_order_status', async ({ orderId, status, waitTime }) => {
    if (!checkAdminSocket(socket)) return;
    if (process.env.DATABASE_URL) {
      try {
        await pool.query('UPDATE orders SET status = $1, wait_time = $2 WHERE id = $3', [status, waitTime || 0, orderId]);
      } catch (err) { console.error("Error updating order:", err); }
    } else {
      const o = localOrders.find(x => x.id === orderId);
      if (o) { o.status = status; if (waitTime !== undefined) o.waitTime = waitTime; }
    }
    io.emit('order_updated', { orderId, status, waitTime });
  });

  socket.on('update_order_items', async ({ orderId, items }) => {
    if (!checkAdminSocket(socket)) return;
    if (process.env.DATABASE_URL) {
      try {
        await pool.query('UPDATE orders SET items = $1 WHERE id = $2', [JSON.stringify(items), orderId]);
      } catch (err) { console.error("Error updating order items:", err); }
    } else {
      const o = localOrders.find(x => x.id === orderId);
      if (o) o.items = items;
    }
    io.emit('order_items_updated', { orderId, items });
  });

  socket.on('update_menu_item', async (item) => {
    if (!checkAdminSocket(socket)) return;
    if (process.env.DATABASE_URL) {
      try {
        await pool.query('UPDATE menu SET available = $1 WHERE id = $2', [item.available, item.id]);
      } catch (err) { console.error("Error updating menu item:", err); }
    } else {
      const m = localMenu.find(x => x.id === item.id);
      if (m) m.available = item.available;
    }
    io.emit('menu_updated', item);
  });

  socket.on('add_menu_item', async (item) => {
    if (!checkAdminSocket(socket)) return;
    if (process.env.DATABASE_URL) {
      try {
        await pool.query('INSERT INTO menu (id, name, emoji, price, category, available) VALUES ($1, $2, $3, $4, $5, $6)',
          [item.id, item.name, item.emoji, item.price, item.category, item.available]);
      } catch (err) { console.error("Error adding menu item:", err); }
    } else {
      localMenu.push(item);
    }
    io.emit('menu_added', item);
  });
  
  socket.on('delete_menu_item', async (itemId) => {
    if (!checkAdminSocket(socket)) return;
    if (process.env.DATABASE_URL) {
      try {
        await pool.query('DELETE FROM menu WHERE id = $1', [itemId]);
      } catch (err) { console.error("Error deleting menu item:", err); }
    } else {
      localMenu = localMenu.filter(x => x.id !== itemId);
    }
    io.emit('menu_deleted', itemId);
  });

  socket.on('disconnect', () => { console.log('Client disconnected'); });
});

app.use((req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
const PORT = process.env.PORT || 5400;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT} (accessible at http://192.168.29.116:${PORT} over WiFi)`);
});
