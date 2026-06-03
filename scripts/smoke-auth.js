const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function projectProbe() {
  const pkg = require('../package.json');
  if (pkg.name === 'mac-files') return { method: 'GET', path: '/api/finder/list' };
  if (pkg.name === 'mac-control') return { method: 'GET', path: '/api/control/memory' };
  return { method: 'POST', path: '/api/terminal/run', body: { command: 'echo ok', cwd: '~' } };
}

async function request(port, probe, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${probe.path}`, {
    method: probe.method,
    headers,
    body: probe.body ? JSON.stringify(probe.body) : undefined,
  });
  return res;
}

async function main() {
  const port = 5200 + Math.floor(Math.random() * 1000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-tool-auth-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: 'auth-secret',
      ADMIN_USERNAME: 'admin-smoke',
      DB_PATH: path.join(tmp, 'app.db'),
      CONTROL_AUTO_START: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });

  try {
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) break;
      } catch {}
      if (child.exitCode !== null) throw new Error(`server exited early\n${output}`);
      await wait(100);
      if (i === 49) throw new Error(`server did not respond\n${output}`);
    }

    const probe = projectProbe();
    const anon = await request(port, probe);
    if (anon.status !== 401) throw new Error(`expected anonymous 401, got ${anon.status}`);

    const userReg = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'plain-smoke', email: 'plain@example.test', password: 'password123' }),
    });
    const user = await userReg.json();
    const userRes = await request(port, probe, user.token);
    if (userRes.status !== 403) throw new Error(`expected user 403, got ${userRes.status}`);

    const adminReg = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin-smoke', email: 'admin@example.test', password: 'password123' }),
    });
    const admin = await adminReg.json();
    const adminRes = await request(port, probe, admin.token);
    if (adminRes.status === 401 || adminRes.status === 403) {
      throw new Error(`expected admin to pass auth boundary, got ${adminRes.status}`);
    }

    console.log('auth smoke ok');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
