const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const port = 4100 + Math.floor(Math.random() * 1000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-tool-startup-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: 'startup-secret',
      ADMIN_USERNAME: 'startup-admin',
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
        if (res.ok) {
          console.log(`startup smoke ok on port ${port}`);
          return;
        }
      } catch {}
      if (child.exitCode !== null) throw new Error(`server exited early\n${output}`);
      await wait(100);
    }
    throw new Error(`server did not respond\n${output}`);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
