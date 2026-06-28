require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Database Connection
// Use DATABASE_URL from Neon for production, otherwise fallback or error
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '/'))); // Serve static files

// Setup Database Schema
async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.warn("No DATABASE_URL provided. Skipping Postgres initialization.");
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS menu (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100),
        emoji VARCHAR(10),
        price INTEGER,
        category VARCHAR(50),
        available BOOLEAN
      );
      
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(50) PRIMARY KEY,
        customer_name VARCHAR(100),
        items JSONB,
        total INTEGER,
        payment_method VARCHAR(50),
        status VARCHAR(50),
        date VARCHAR(20),
        timestamp BIGINT,
        wait_time INTEGER
      );
      
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(50) PRIMARY KEY,
        value JSONB
      );
    `);
    
    // Seed default menu if empty
    const res = await pool.query('SELECT count(*) FROM menu');
    if (parseInt(res.rows[0].count) === 0) {
      const defaultMenu = [
        { id: 'v1', name: 'Veg Burger', emoji: '🍔', price: 100, category: 'veg', available: true },
        { id: 'v2', name: 'Veg Wrap', emoji: '🌯', price: 90, category: 'veg', available: true },
        { id: 'v3', name: 'Loaded Fries', emoji: '🍟', price: 80, category: 'veg', available: true },
        { id: 'n1', name: 'Chicken Burger', emoji: '🍔', price: 140, category: 'nonveg', available: true },
        { id: 'n2', name: 'Chicken Wrap', emoji: '🌯', price: 130, category: 'nonveg', available: true },
        { id: 'n3', name: 'Chicken Fries', emoji: '🍗', price: 120, category: 'nonveg', available: true }
      ];
      for (const item of defaultMenu) {
        await pool.query(
          'INSERT INTO menu (id, name, emoji, price, category, available) VALUES ($1, $2, $3, $4, $5, $6)',
          [item.id, item.name, item.emoji, item.price, item.category, item.available]
        );
      }
    }
    console.log("Database initialized successfully.");
  } catch (err) {
    console.error("Database initialization failed:", err);
  }
}

initDB();

// API ROUTES
app.get('/api/menu', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json([]);
  try {
    const result = await pool.query('SELECT * FROM menu');
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching menu:", err);
    res.status(500).json([]);
  }
});

app.get('/api/orders', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json([]);
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json([]);
  }
});

app.get('/api/settings', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({});
  try {
    const result = await pool.query("SELECT * FROM settings WHERE key = 'app_settings'");
    if (result.rows.length > 0) return res.json(result.rows[0].value);
    res.json({});
  } catch (err) {
    console.error("Error fetching settings:", err);
    res.status(500).json({});
  }
});

// WEBSOCKETS (Real-time sync)
io.on('connection', (socket) => {
  console.log('A client connected');
  
  socket.on('new_order', async (order) => {
    // Save to DB
    if (process.env.DATABASE_URL) {
      try {
        await pool.query(
          'INSERT INTO orders (id, customer_name, items, total, payment_method, status, date, timestamp, wait_time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [order.id, order.customerName, JSON.stringify(order.items), order.total, order.paymentMethod, order.status, order.date, order.timestamp, order.waitTime]
        );
      } catch (err) {
        console.error("Failed to save order", err);
      }
    }
    // Broadcast to all clients (including admin)
    io.emit('order_added', order);
  });

  socket.on('update_order_status', async ({ orderId, status }) => {
    if (process.env.DATABASE_URL) {
      try {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
      } catch (err) { console.error("Error updating order:", err); }
    }
    io.emit('order_updated', { orderId, status });
  });

  socket.on('update_menu_item', async (item) => {
    if (process.env.DATABASE_URL) {
      try {
        await pool.query(
          'UPDATE menu SET available = $1 WHERE id = $2',
          [item.available, item.id]
        );
      } catch (err) { console.error("Error updating menu item:", err); }
    }
    io.emit('menu_updated', item);
  });

  socket.on('add_menu_item', async (item) => {
    if (process.env.DATABASE_URL) {
      try {
        await pool.query(
          'INSERT INTO menu (id, name, emoji, price, category, available) VALUES ($1, $2, $3, $4, $5, $6)',
          [item.id, item.name, item.emoji, item.price, item.category, item.available]
        );
      } catch (err) { console.error("Error adding menu item:", err); }
    }
    io.emit('menu_added', item);
  });
  
  socket.on('delete_menu_item', async (itemId) => {
    if (process.env.DATABASE_URL) {
      try {
        await pool.query('DELETE FROM menu WHERE id = $1', [itemId]);
      } catch (err) { console.error("Error deleting menu item:", err); }
    }
    io.emit('menu_deleted', itemId);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Catch-all route to serve index.html for SPA routing and prevent 404s
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5400;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
