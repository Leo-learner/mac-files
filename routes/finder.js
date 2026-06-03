// Finder / File Browser routes — file listing, reading, search, upload, and management
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuid } = require('uuid');
const { spawn } = require('child_process');
const iconv = require('iconv-lite');
const { createRootLogger } = require('../lib/logger');
const { authRequired, adminOnly } = require('../auth');
const { createRateLimiter } = require('../lib/rate-limiter');

const router = express.Router();
const rootLogger = createRootLogger();

const DEFAULT_FINDER_ROOT = fs.existsSync(path.join(os.homedir(), 'Downloads'))
  ? path.join(os.homedir(), 'Downloads')
  : os.homedir();
const FINDER_ROOT = path.resolve(process.env.FINDER_ROOT || DEFAULT_FINDER_ROOT);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss', '.less',
  '.xml', '.yml', '.yaml', '.csv', '.log', '.sh', '.py', '.rb', '.php', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp', '.m', '.swift', '.sql', '.ini', '.conf', '.toml', '.env',
]);

const finderSearchLimiter = createRateLimiter({ name: 'finder-search', windowMs: 60000, max: 120 });

// ── Path helpers ─────────────────────────────────────────
function normalizeFinderRelative(input = '') {
  let rel = String(input || '').replace(/\0/g, '').replace(/^~[/]/, '');
  rel = rel.replace(/^\/+/, '');
  rel = path.normalize(rel);
  if (rel === '.' || rel === path.sep) rel = '';
  rel = rel.split(path.sep).filter(Boolean).join(path.sep);
  if (rel.startsWith('..')) throw new Error('Invalid path');
  return rel;
}

function resolveFinderPath(relative = '') {
  const rel = normalizeFinderRelative(relative);
  const abs = path.resolve(FINDER_ROOT, rel);
  if (abs !== FINDER_ROOT && !abs.startsWith(FINDER_ROOT + path.sep)) {
    throw new Error('Path outside allowed root');
  }
  return { rel, abs };
}

function relFromAbs(abs) {
  const rel = path.relative(FINDER_ROOT, abs);
  return rel.split(path.sep).filter(Boolean).join('/');
}

function prettyRootLabel() {
  const base = path.basename(FINDER_ROOT);
  return base || 'Home';
}

function parentRelative(rel) {
  if (!rel) return '';
  return rel.split('/').filter(Boolean).slice(0, -1).join('/');
}

function safeJoinTarget(targetRel, baseName) {
  const { abs: targetAbs } = resolveFinderPath(targetRel);
  const destAbs = path.resolve(targetAbs, baseName);
  if (destAbs !== FINDER_ROOT && !destAbs.startsWith(FINDER_ROOT + path.sep)) {
    throw new Error('Invalid destination');
  }
  return destAbs;
}

async function ensureUniqueDestination(destAbs) {
  if (!fs.existsSync(destAbs)) return destAbs;
  const dir = path.dirname(destAbs);
  const ext = path.extname(destAbs);
  const base = path.basename(destAbs, ext);
  for (let i = 1; i < 2000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find free destination name');
}

function normalizeSearchQuery(input = '') {
  return String(input || '').replace(/\0/g, '').trim().normalize('NFKC').toLowerCase();
}

function tokenizeSearchQuery(input = '') {
  return normalizeSearchQuery(input).split(/[\s/_\-]+/g).map(p => p.trim()).filter(Boolean);
}

function contentDispositionFilename(filename) {
  const safe = String(filename || 'download').replace(/[\r\n"]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_');
  return `attachment; filename="${ascii || 'download'}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

// ── Encoding detection ───────────────────────────────────
function decodePreviewBuffer(buffer) {
  const utf8Text = iconv.decode(buffer, 'utf8').replace(/^\uFEFF/, '');
  const utf8Sample = utf8Text.slice(0, 20000);
  const utf8ReplacementCount = (utf8Sample.match(/�/g) || []).length;
  const utf8ControlCount = (utf8Sample.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
  const utf8PrintableCount = (utf8Sample.match(/[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g) || []).length;
  const utf8PrintableRatio = utf8Sample.length ? utf8PrintableCount / utf8Sample.length : 1;
  if (utf8ReplacementCount === 0 && utf8ControlCount === 0 && utf8PrintableRatio > 0.92) {
    return { text: utf8Text, encoding: 'utf8' };
  }

  const candidates = ['utf8', 'gb18030', 'gbk', 'big5', 'utf16le', 'latin1'];
  let best = { text: '', score: -Infinity, encoding: 'utf8' };
  for (const encoding of candidates) {
    let text;
    try { text = iconv.decode(buffer, encoding); } catch { continue; }
    text = String(text || '').replace(/^\uFEFF/, '');
    const sample = text.slice(0, 20000);
    const repCnt = (sample.match(/�/g) || []).length;
    const nullCnt = (sample.match(/\x00/g) || []).length;
    const printCnt = (sample.match(/[\x20-\x7E\u00A0-\uFFFF]/g) || []).length;
    const cjkCnt = (sample.match(/[\u4E00-\u9FFF]/g) || []).length;
    const penalty = encoding === 'utf16le' && !/^\uFEFF/.test(text) && nullCnt === 0 ? 120 : 0;
    const score = (printCnt + cjkCnt * 2) - (repCnt * 80) - (nullCnt * 30) - penalty;
    if (score > best.score) best = { text, score, encoding };
  }
  return best;
}

async function readTextPreview(abs, limit = 12000) {
  const maxBytes = Math.max(64 * 1024, Math.min(512 * 1024, limit * 16));
  const fh = await fs.promises.open(abs, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
    const { text, encoding } = decodePreviewBuffer(buffer.subarray(0, bytesRead));
    return { preview: text.slice(0, limit), encoding };
  } finally {
    await fh.close().catch(() => {});
  }
}

// ── Search walker ─────────────────────────────────────────
async function walkFinderMatches(rootAbs, query, { maxResults = 1000, maxVisited = 50000 } = {}) {
  const matches = [];
  const queue = [rootAbs];
  const seen = new Set();
  let visited = 0;
  const normalizedQuery = normalizeSearchQuery(query);
  const queryTokens = tokenizeSearchQuery(query);

  while (queue.length && matches.length < maxResults && visited < maxVisited) {
    const dirAbs = queue.shift();
    if (seen.has(dirAbs)) continue;
    seen.add(dirAbs);
    visited++;

    let entries;
    try { entries = await fs.promises.readdir(dirAbs, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    for (const dirent of entries) {
      const itemAbs = path.join(dirAbs, dirent.name);
      let itemStat;
      try { itemStat = await fs.promises.lstat(itemAbs); } catch { continue; }
      const type = itemStat.isDirectory() ? 'dir' : itemStat.isSymbolicLink() ? 'symlink' : 'file';
      const rel = relFromAbs(itemAbs);
      const haystack = normalizeSearchQuery(`${dirent.name} ${rel}`);
      const nameStack = normalizeSearchQuery(dirent.name);
      const matched = queryTokens.length
        ? queryTokens.every(t => haystack.includes(t) || nameStack.includes(t))
        : haystack.includes(normalizedQuery);
      if (matched) {
        matches.push({ name: dirent.name, path: rel, type, size: itemStat.size, mtimeMs: itemStat.mtimeMs, hidden: dirent.name.startsWith('.'), ext: path.extname(dirent.name).toLowerCase() });
        if (matches.length >= maxResults) break;
      }
      if (type === 'dir') queue.push(itemAbs);
    }
  }
  matches.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.path.localeCompare(b.path, 'zh-CN');
  });
  return matches;
}

// ── Directory archive (zip) ──────────────────────────────
async function createDirectoryArchive(abs) {
  const baseName = path.basename(abs);
  const tempBase = path.join(os.tmpdir(), `finder-${uuid()}`);
  const zipPath = `${tempBase}.zip`;
  const pythonScript = `
import os, sys, zipfile
source = sys.argv[1]
destination = sys.argv[2]
base_parent = os.path.dirname(source)
with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for root, dirs, files in os.walk(source):
        for name in dirs + files:
            full_path = os.path.join(root, name)
            relative_path = os.path.relpath(full_path, base_parent)
            archive.write(full_path, relative_path)
`;

  const runner = await new Promise((resolve) => {
    const candidates = [process.env.PYTHON || 'python3', 'python'];
    let index = 0;
    const tryNext = () => {
      if (index >= candidates.length) { resolve(null); return; }
      const cmd = candidates[index++];
      const child = spawn(cmd, ['-c', pythonScript, abs, zipPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', tryNext);
      child.on('close', code => {
        if (code === 0) resolve(true);
        else if (index < candidates.length) tryNext();
        else resolve(new Error(stderr.trim() || `Archive creation failed (${code})`));
      });
    };
    tryNext();
  });

  if (runner instanceof Error) throw runner;
  if (!runner) {
    await new Promise((resolve, reject) => {
      const zip = spawn('zip', ['-qry', zipPath, baseName], { cwd: path.dirname(abs) });
      let stderr = '';
      zip.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      zip.on('error', reject);
      zip.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Archive creation failed (${code})`));
      });
    });
  }
  return { archivePath: zipPath, downloadName: `${baseName}.zip` };
}

// ── Routes ────────────────────────────────────────────────
router.use(authRequired);
router.use(adminOnly);

router.get('/list', async (req, res) => {
  try {
    const rel = normalizeFinderRelative(req.query.path || '');
    const { abs } = resolveFinderPath(rel);
    const stat = await fs.promises.lstat(abs);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });
    const dirents = await fs.promises.readdir(abs, { withFileTypes: true });
    const items = [];
    for (const dirent of dirents) {
      const itemAbs = path.join(abs, dirent.name);
      let itemStat;
      try { itemStat = await fs.promises.lstat(itemAbs); } catch { continue; }
      items.push({ name: dirent.name, path: relFromAbs(itemAbs), type: itemStat.isDirectory() ? 'dir' : itemStat.isSymbolicLink() ? 'symlink' : 'file', size: itemStat.size, mtimeMs: itemStat.mtimeMs, hidden: dirent.name.startsWith('.'), ext: path.extname(dirent.name).toLowerCase() });
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'dir' ? -1 : 1));
    res.json({ rootLabel: prettyRootLabel(), rootPath: FINDER_ROOT, cwd: rel, parent: parentRelative(rel), items });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to list directory' });
  }
});

router.get('/read', async (req, res) => {
  try {
    const rel = normalizeFinderRelative(req.query.path || '');
    const { abs } = resolveFinderPath(rel);
    const stat = await fs.promises.lstat(abs);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
    const ext = path.extname(abs).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && stat.size > 256 * 1024) {
      return res.json({ path: rel, preview: null, reason: 'Binary or large file', size: stat.size, mtimeMs: stat.mtimeMs });
    }
    const { preview, encoding } = await readTextPreview(abs);
    res.json({ path: rel, preview: preview.slice(0, 12000), encoding, reason: null, size: stat.size, mtimeMs: stat.mtimeMs });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to read file' });
  }
});

router.get('/search', finderSearchLimiter, async (req, res) => {
  try {
    const rel = normalizeFinderRelative(req.query.path || '');
    const query = normalizeSearchQuery(req.query.q || '');
    if (!query) {
      return res.json({ rootLabel: prettyRootLabel(), rootPath: FINDER_ROOT, cwd: rel, parent: parentRelative(rel), items: [] });
    }
    const matches = await walkFinderMatches(FINDER_ROOT, query, { maxResults: 1000 });
    res.json({ rootLabel: prettyRootLabel(), rootPath: FINDER_ROOT, cwd: rel, parent: parentRelative(rel), query, items: matches, truncated: matches.length >= 1000, maxResults: 1000 });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to search files' });
  }
});

router.get('/download', async (req, res) => {
  let tempArchive = null;
  let stream = null;
  try {
    const rel = normalizeFinderRelative(req.query.path || '');
    const { abs } = resolveFinderPath(rel);
    const stat = await fs.promises.lstat(abs);
    let filePath = abs;
    let downloadName = path.basename(abs);
    if (stat.isDirectory()) {
      const archive = await createDirectoryArchive(abs);
      tempArchive = archive.archivePath;
      filePath = tempArchive;
      downloadName = archive.downloadName;
    } else if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a file or folder' });
    }
    const fileStat = await fs.promises.stat(filePath);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(fileStat.size));
    res.setHeader('Content-Disposition', contentDispositionFilename(downloadName));
    stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      req.log.error('Download stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
      else res.destroy(err);
    });
    res.on('close', async () => {
      if (stream) { try { stream.destroy(); } catch {} }
      if (tempArchive) { try { await fs.promises.unlink(tempArchive); } catch {} }
    });
    stream.pipe(res);
  } catch (err) {
    if (stream) { try { stream.destroy(); } catch {} }
    if (tempArchive) { try { await fs.promises.unlink(tempArchive); } catch {} }
    res.status(400).json({ error: err.message || 'Failed to download file' });
  }
});

router.post('/mkdir', async (req, res) => {
  try {
    const cwd = normalizeFinderRelative(req.body.path || '');
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Folder name is required' });
    if (name.includes('/')) return res.status(400).json({ error: 'Folder name cannot contain slashes' });
    const destAbs = await ensureUniqueDestination(safeJoinTarget(cwd, name));
    await fs.promises.mkdir(destAbs, { recursive: false });
    res.json({ ok: true, path: relFromAbs(destAbs) });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to create folder' });
  }
});

router.post('/rename', async (req, res) => {
  try {
    const rel = normalizeFinderRelative(req.body.path || '');
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'New name is required' });
    if (name.includes('/')) return res.status(400).json({ error: 'Name cannot contain slashes' });
    const { abs } = resolveFinderPath(rel);
    const destAbs = await ensureUniqueDestination(path.join(path.dirname(abs), name));
    await fs.promises.rename(abs, destAbs);
    res.json({ ok: true, path: relFromAbs(destAbs) });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to rename item' });
  }
});

router.post('/delete', async (req, res) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    if (!paths.length) return res.status(400).json({ error: 'No paths selected' });
    for (const relInput of paths) {
      const { abs } = resolveFinderPath(normalizeFinderRelative(relInput));
      await fs.promises.rm(abs, { recursive: true, force: true });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to delete items' });
  }
});

router.post('/copy', async (req, res) => {
  try {
    const sources = Array.isArray(req.body.sources) ? req.body.sources : [];
    const target = normalizeFinderRelative(req.body.target || '');
    if (!sources.length) return res.status(400).json({ error: 'No sources selected' });
    const { abs: targetAbs } = resolveFinderPath(target);
    if (!(await fs.promises.lstat(targetAbs)).isDirectory()) return res.status(400).json({ error: 'Target is not a folder' });
    for (const srcInput of sources) {
      const { abs: srcAbs } = resolveFinderPath(normalizeFinderRelative(srcInput));
      const destAbs = await ensureUniqueDestination(path.join(targetAbs, path.basename(srcAbs)));
      await fs.promises.cp(srcAbs, destAbs, { recursive: true, errorOnExist: false, force: false, preserveTimestamps: true });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to copy items' });
  }
});

router.post('/move', async (req, res) => {
  try {
    const sources = Array.isArray(req.body.sources) ? req.body.sources : [];
    const target = normalizeFinderRelative(req.body.target || '');
    if (!sources.length) return res.status(400).json({ error: 'No sources selected' });
    const { abs: targetAbs } = resolveFinderPath(target);
    if (!(await fs.promises.lstat(targetAbs)).isDirectory()) return res.status(400).json({ error: 'Target is not a folder' });
    for (const srcInput of sources) {
      const { abs: srcAbs } = resolveFinderPath(normalizeFinderRelative(srcInput));
      const destAbs = await ensureUniqueDestination(path.join(targetAbs, path.basename(srcAbs)));
      await fs.promises.rename(srcAbs, destAbs);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to move items' });
  }
});

router.post('/upload', async (req, res) => {
  let destAbs = null;
  let tempAbs = null;
  let out = null;
  try {
    const target = normalizeFinderRelative(req.query.path || '');
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Filename is required' });
    if (name.includes('/')) return res.status(400).json({ error: 'Filename cannot contain slashes' });
    const { abs: targetAbs } = resolveFinderPath(target);
    if (!(await fs.promises.lstat(targetAbs)).isDirectory()) return res.status(400).json({ error: 'Target is not a folder' });
    destAbs = await ensureUniqueDestination(path.join(targetAbs, name));
    tempAbs = `${destAbs}.upload-${uuid()}.part`;

    await new Promise((resolve, reject) => {
      out = fs.createWriteStream(tempAbs, { flags: 'wx' });
      let settled = false;
      const cleanup = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };
      req.on('aborted', () => cleanup(new Error('Upload cancelled')));
      req.on('error', cleanup);
      out.on('error', cleanup);
      out.on('finish', () => cleanup());
      req.pipe(out);
    });

    await fs.promises.rename(tempAbs, destAbs);
    tempAbs = null;
    res.json({ ok: true, path: relFromAbs(destAbs) });
  } catch (err) {
    if (out) { try { out.destroy(); } catch {} }
    if (tempAbs) { try { await fs.promises.unlink(tempAbs); } catch {} }
    if (destAbs && !tempAbs) { try { await fs.promises.unlink(destAbs); } catch {} }
    res.status(400).json({ error: err.message || 'Failed to upload file' });
  }
});

router.finderRoot = FINDER_ROOT;
router.prettyRootLabel = prettyRootLabel;

module.exports = router;
