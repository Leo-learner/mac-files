const state = {
  token: localStorage.getItem('mac-files-token') || '',
  user: null,
  cwd: '',
  parent: '',
  items: [],
  selected: new Set(),
  clipboard: null,
  query: '',
};

const $ = id => document.getElementById(id);

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 1800);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof Blob)) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, {
    ...options,
    headers,
    body: options.body instanceof Blob ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });
  if (options.download) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderConfig(config) {
  const fieldsEl = $('configFields');
  const secretsEl = $('configSecrets');
  $('configPath').textContent = config.envExists ? config.envPath : `${config.envPath} will be created`;
  fieldsEl.innerHTML = config.fields.map(field => {
    const value = escapeHtml(field.value || '');
    const control = field.type === 'boolean'
      ? `<select data-config-key="${field.key}"><option value="true" ${field.value === 'true' ? 'selected' : ''}>true</option><option value="false" ${field.value !== 'true' ? 'selected' : ''}>false</option></select>`
      : `<input data-config-key="${field.key}" type="${field.type === 'number' ? 'number' : 'text'}" value="${value}">`;
    return `<div class="config-field">
      <label>${escapeHtml(field.label)}</label>
      ${control}
      <small>${field.key}${field.restart ? ' · restart required' : ''}</small>
    </div>`;
  }).join('');
  secretsEl.innerHTML = config.secrets.map(secret => `<div class="secret-row">
    <div>
      <label>${escapeHtml(secret.key)}</label>
      <small>${escapeHtml(secret.masked)} · value is never shown</small>
    </div>
    <label><input type="checkbox" data-rotate-secret="${escapeHtml(secret.key)}"> rotate</label>
  </div>`).join('');
}

async function openConfigPanel() {
  $('configPanel').classList.remove('hidden');
  const config = await api('/api/config');
  renderConfig(config);
}

function closeConfigPanel() {
  $('configPanel').classList.add('hidden');
}

async function saveConfigPanel() {
  const fields = {};
  document.querySelectorAll('[data-config-key]').forEach(input => {
    fields[input.dataset.configKey] = input.value;
  });
  const rotateSecrets = [...document.querySelectorAll('[data-rotate-secret]:checked')].map(input => input.dataset.rotateSecret);
  const config = await api('/api/config', { method: 'POST', body: { fields, rotateSecrets } });
  renderConfig(config);
  toast('Settings saved. Restart to apply server-level changes.');
}

function showApp(user) {
  state.user = user;
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userLabel').textContent = `${user.username} · ${user.role}`;
  loadFiles('');
}

function showAuth() {
  state.token = '';
  state.user = null;
  localStorage.removeItem('mac-files-token');
  $('authView').classList.remove('hidden');
  $('appView').classList.add('hidden');
}

async function login(register = false) {
  $('authError').textContent = '';
  try {
    const data = await api(`/api/auth/${register ? 'register' : 'login'}`, {
      method: 'POST',
      body: {
        username: $('username').value.trim(),
        email: $('email').value.trim(),
        password: $('password').value,
      },
    });
    state.token = data.token;
    localStorage.setItem('mac-files-token', state.token);
    showApp(data.user);
  } catch (err) {
    $('authError').textContent = err.message;
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function formatSize(size) {
  if (!Number.isFinite(size)) return '--';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function loadFiles(path = state.cwd) {
  const endpoint = state.query.trim()
    ? `/api/finder/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(state.query.trim())}`
    : `/api/finder/list?path=${encodeURIComponent(path)}`;
  const data = await api(endpoint);
  state.cwd = data.cwd || path || '';
  state.parent = data.parent || '';
  state.items = data.items || [];
  state.selected.clear();
  $('pathLabel').textContent = data.rootLabel ? `${data.rootLabel}/${state.cwd}` : state.cwd || '/';
  $('summary').textContent = state.query.trim()
    ? `${state.items.length} search result${state.items.length === 1 ? '' : 's'}`
    : `${state.items.length} item${state.items.length === 1 ? '' : 's'}`;
  renderBreadcrumbs();
  renderList();
  updateSelection();
}

function renderBreadcrumbs() {
  const parts = state.cwd ? state.cwd.split('/').filter(Boolean) : [];
  const crumbs = [{ label: 'Root', path: '' }];
  parts.forEach((part, index) => crumbs.push({ label: part, path: parts.slice(0, index + 1).join('/') }));
  $('breadcrumbs').innerHTML = crumbs.map(c => `<button data-path="${escapeHtml(c.path)}">${escapeHtml(c.label)}</button>`).join('');
}

function renderList() {
  $('empty').classList.toggle('hidden', state.items.length > 0);
  $('list').innerHTML = state.items.map(item => `
    <div class="file-row ${state.selected.has(item.path) ? 'selected' : ''}" data-path="${escapeHtml(item.path)}">
      <button class="check" data-select="${escapeHtml(item.path)}">${state.selected.has(item.path) ? '✓' : ''}</button>
      <div class="file-icon">${item.type === 'dir' ? 'Folder' : 'File'}</div>
      <div class="file-main">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.type)} · ${formatSize(item.size)}</span>
      </div>
      <button data-open="${escapeHtml(item.path)}">${item.type === 'dir' ? 'Open' : 'Preview'}</button>
    </div>
  `).join('');
}

function updateSelection() {
  const count = state.selected.size;
  $('selectionCount').textContent = `${count} selected`;
  $('selectionBar').classList.toggle('hidden', count === 0);
  $('renameBtn').disabled = count !== 1;
  $('pasteBtn').disabled = !state.clipboard;
}

async function previewFile(path) {
  const data = await api(`/api/finder/read?path=${encodeURIComponent(path)}`);
  $('previewTitle').textContent = path;
  $('previewContent').textContent = data.preview || data.reason || 'No text preview available.';
  $('previewPanel').classList.remove('hidden');
}

async function downloadSelected() {
  for (const path of state.selected) {
    const res = await api(`/api/finder/download?path=${encodeURIComponent(path)}`, { download: true });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'download';
    a.click();
    URL.revokeObjectURL(url);
  }
}

$('loginBtn').addEventListener('click', () => login(false));
$('registerBtn').addEventListener('click', () => login(true));
$('logoutBtn').addEventListener('click', showAuth);
$('settingsBtn').addEventListener('click', () => openConfigPanel().catch(err => toast(err.message)));
$('closeConfigBtn').addEventListener('click', closeConfigPanel);
$('saveConfigBtn').addEventListener('click', () => saveConfigPanel().catch(err => toast(err.message)));
$('refreshBtn').addEventListener('click', () => loadFiles());
$('upBtn').addEventListener('click', () => loadFiles(state.parent || ''));
$('selectAllBtn').addEventListener('click', () => {
  state.items.forEach(item => state.selected.add(item.path));
  renderList();
  updateSelection();
});
$('clearBtn').addEventListener('click', () => {
  state.selected.clear();
  renderList();
  updateSelection();
});
$('newFolderBtn').addEventListener('click', async () => {
  const name = prompt('Folder name');
  if (!name) return;
  await api('/api/finder/mkdir', { method: 'POST', body: { path: state.cwd, name } });
  toast('Folder created');
  loadFiles();
});
$('deleteBtn').addEventListener('click', async () => {
  if (!state.selected.size || !confirm(`Delete ${state.selected.size} item(s)?`)) return;
  await api('/api/finder/delete', { method: 'POST', body: { paths: [...state.selected] } });
  toast('Deleted');
  loadFiles();
});
$('renameBtn').addEventListener('click', async () => {
  const current = [...state.selected][0];
  const name = prompt('New name', current.split('/').pop());
  if (!name) return;
  await api('/api/finder/rename', { method: 'POST', body: { path: current, name } });
  toast('Renamed');
  loadFiles();
});
$('copyBtn').addEventListener('click', () => {
  state.clipboard = { mode: 'copy', sources: [...state.selected] };
  toast('Copied to clipboard');
  updateSelection();
});
$('cutBtn').addEventListener('click', () => {
  state.clipboard = { mode: 'move', sources: [...state.selected] };
  toast('Cut to clipboard');
  updateSelection();
});
$('pasteBtn').addEventListener('click', async () => {
  if (!state.clipboard) return;
  await api(`/api/finder/${state.clipboard.mode}`, {
    method: 'POST',
    body: { sources: state.clipboard.sources, target: state.cwd },
  });
  state.clipboard = null;
  toast('Pasted');
  loadFiles();
});
$('downloadBtn').addEventListener('click', () => downloadSelected().catch(err => toast(err.message)));
$('uploadBtn').addEventListener('click', () => $('uploadInput').click());
$('uploadInput').addEventListener('change', async e => {
  for (const file of e.target.files || []) {
    await api(`/api/finder/upload?path=${encodeURIComponent(state.cwd)}&name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  }
  e.target.value = '';
  toast('Upload complete');
  loadFiles();
});
$('searchInput').addEventListener('input', e => {
  state.query = e.target.value;
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => loadFiles(state.cwd), 180);
});
$('breadcrumbs').addEventListener('click', e => {
  const btn = e.target.closest('[data-path]');
  if (btn) loadFiles(btn.dataset.path);
});
$('list').addEventListener('click', e => {
  const select = e.target.closest('[data-select]');
  const open = e.target.closest('[data-open]');
  if (select) {
    const path = select.dataset.select;
    if (state.selected.has(path)) state.selected.delete(path);
    else state.selected.add(path);
    renderList();
    updateSelection();
  } else if (open) {
    const path = open.dataset.open;
    const item = state.items.find(entry => entry.path === path);
    if (item?.type === 'dir') loadFiles(path);
    else previewFile(path).catch(err => toast(err.message));
  }
});
$('closePreviewBtn').addEventListener('click', () => $('previewPanel').classList.add('hidden'));
$('password').addEventListener('keydown', e => {
  if (e.key === 'Enter') login(false);
});

(async function boot() {
  if (!state.token) return showAuth();
  try {
    const data = await api('/api/auth/me');
    showApp(data.user);
  } catch {
    showAuth();
  }
})();
