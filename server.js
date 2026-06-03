require('dotenv').config();

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { signToken, authRequired, adminOnly } = require('./auth');
const { DB_PATH, userQueries } = require('./db');
const { createLogger } = require('./lib/logger');
const finderRoutes = require('./routes/finder');
const { getConfig, saveConfig } = require('./config-panel');

const app = express();
const PROJECT_NAME = 'mac-files';
const PORT = Number(process.env.PORT || 3302);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Leo';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function applyCors(req, res, next) {
  const allowed = (process.env.ALLOWED_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

function validateRuntime() {
  if ((process.env.JWT_SECRET || 'dev-secret-change-me') === 'dev-secret-change-me') {
    const msg = 'JWT_SECRET is using the development default. Set a strong value before exposing this app.';
    if (process.env.NODE_ENV === 'production') throw new Error(msg);
    log('WARN', msg);
  }
}

app.use(applyCors);
app.use(securityHeaders);
app.use((req, res, next) => {
  req.id = uuid();
  req.log = createLogger(req);
  res.setHeader('X-Request-ID', req.id);
  next();
});
app.use(express.json({ limit: '1mb', type: 'application/json' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'mac-files', db: DB_PATH, finderRoot: finderRoutes.finderRoot });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!username || !email || password.length < 8) {
      return res.status(400).json({ error: 'Username, email, and an 8+ character password are required' });
    }
    if (userQueries.findByUsername.get(username) || userQueries.findByEmail.get(email)) {
      return res.status(409).json({ error: 'User already exists' });
    }
    const id = uuid();
    const role = username === ADMIN_USERNAME ? 'admin' : 'user';
    const hash = await bcrypt.hash(password, 10);
    userQueries.create.run(id, username, email, hash, role);
    const user = userQueries.findById.get(id);
    res.json({ token: signToken(user), user });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const userRecord = userQueries.findByUsername.get(username);
  if (!userRecord || !(await bcrypt.compare(password, userRecord.password))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const user = userQueries.findById.get(userRecord.id);
  res.json({ token: signToken(user), user });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/config', authRequired, adminOnly, (req, res) => {
  res.json(getConfig(PROJECT_NAME));
});

app.post('/api/config', authRequired, adminOnly, (req, res) => {
  try {
    res.json(saveConfig(PROJECT_NAME, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to save configuration' });
  }
});

app.use('/api/finder', finderRoutes);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

validateRuntime();
app.listen(PORT, () => {
  log(`mac-files running at http://localhost:${PORT}`);
  log(`Database: ${DB_PATH}`);
  log(`Finder root: ${finderRoutes.finderRoot}`);
});
