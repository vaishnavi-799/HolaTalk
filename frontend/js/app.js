const $ = s => document.querySelector(s);
let me, cur, sock, reg = false, oldest = null, more = false, file = null; const online = new Set();
const api = async (u, o = {}) => {
  const r = await fetch(u, { method: o.method || 'GET', credentials: 'same-origin', headers: o.body ? { 'Content-Type': 'application/json' } : {}, body: o.body && JSON.stringify(o.body) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Request failed'); return d; };
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const showErr = m => { const e = $('#err'); e.textContent = m; e.classList.toggle('d-none', !m); };
const fmt = d => new Date(d).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

$('#toggle').onclick = () => { reg = !reg; document.querySelectorAll('.reg').forEach(e => e.classList.toggle('d-none', !reg)); $('#sub').textContent = reg ? 'Register' : 'Log in'; };
$('#af').onsubmit = async e => { e.preventDefault(); showErr('');
  try { start((await api(reg ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) })).user); } catch (x) { showErr(x.message); } };
$('#out').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.reload(); };

function start(u) {
  me = u; $('#auth').classList.add('d-none'); $('#chat').classList.remove('d-none');
  sock = io();
  sock.on('presence', ids => { ids.forEach(i => online.add(i)); status(); });
  sock.on('user:online', i => { online.add(i); status(); });
  sock.on('user:offline', i => { online.delete(i); status(); });
  sock.on('message:new', m => { if (cur && m.conversationId === cur.id) add(m); loadConvs(); });
  sock.on('connect_error', () => $('#hs').textContent = 'Reconnecting…');
  loadConvs();
}
function status() { if (cur) $('#hs').textContent = online.has(cur.other.id) ? 'online' : 'offline'; }
async function loadConvs() {
  const { conversations } = await api('/api/conversations'); const l = $('#list'); l.replaceChildren();
  conversations.forEach(c => { const i = el('div', 'item'); i.append(el('b', '', c.other.displayName), el('div', 'small text-muted', c.lastMessage || 'No messages yet')); i.onclick = () => open(c); l.append(i); });
}
$('#q').oninput = async e => {
  const q = e.target.value.trim(); if (q.length < 2) return loadConvs();
  const { users } = await api('/api/users/search?q=' + encodeURIComponent(q)); const l = $('#list'); l.replaceChildren();
  users.forEach(u => { const i = el('div', 'item', `${u.displayName} (@${u.username})`);
    i.onclick = async () => { const { conversation } = await api('/api/conversations', { method: 'POST', body: { userId: u.id } }); $('#q').value = ''; open(conversation); loadConvs(); }; l.append(i); });
  if (!users.length) l.append(el('div', 'p-3 text-muted', 'No users found'));
};
async function open(c) {
  cur = c; $('#chat').classList.add('open'); $('#hn').textContent = c.other.displayName; $('#msgs').replaceChildren(); status(); oldest = null; await older(); $('#msgs').scrollTop = 1e9;
}
async function older() {
  const { messages, hasMore } = await api(`/api/conversations/${cur.id}/messages?limit=30` + (oldest ? '&before=' + encodeURIComponent(oldest) : ''));
  more = hasMore; const box = $('#msgs'), h = box.scrollHeight;
  messages.forEach(m => add(m, true)); if (messages.length) oldest = messages[messages.length - 1].createdAt; box.scrollTop += box.scrollHeight - h;
}
$('#msgs').onscroll = e => { if (e.target.scrollTop === 0 && more && cur) older().catch(() => {}); };
$('#back').onclick = () => { $('#chat').classList.remove('open'); cur = null; };
function add(m, prepend) {
  const box = $('#msgs'); if (box.querySelector(`[data-id="${m.id}"]`)) return;
  const mine = m.senderId === me.id, b = el('div', 'b' + (mine ? ' me' : '')); b.dataset.id = m.id;
  if (m.type === 'text') b.append(el('div', '', m.text));
  else if (m.type === 'location') {
    const { lat, lng } = m.location; b.append(el('div', '', '📍 Shared location'), el('div', 'small', `${lat.toFixed(5)}, ${lng.toFixed(5)}`));
    const a = el('a', 'small', 'Open in Maps'); a.href = `https://www.google.com/maps?q=${lat},${lng}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; b.append(a);
  } else {
    const src = '/api/media/' + m.media.id; const n = el(m.type === 'image' ? 'img' : 'video'); n.src = src; if (m.type === 'video') n.controls = true; b.append(n);
    const a = el('a', 'small', 'Download'); a.href = src + '?download=1'; b.append(a);
  }
  b.append(el('div', 't', fmt(m.createdAt) + (mine ? (m.deliveredAt ? ' ✓✓' : ' ✓') : '')));
  prepend ? box.prepend(b) : (box.append(b), box.scrollTop = box.scrollHeight);
}
const emit = p => sock.timeout(8000).emit('message:send', { ...p, conversationId: cur.id, clientId: crypto.randomUUID() }, (err, r) => {
  if (err || !r || !r.ok) return alert(err ? 'Network problem. Please try again.' : r.error); add(r.message); });
const send = () => { const t = $('#txt').value.trim(); if (!t || !cur) return; emit({ type: 'text', text: t }); $('#txt').value = ''; };
$('#send').onclick = send; $('#txt').onkeydown = e => { if (e.key === 'Enter') send(); };
$('#loc').onclick = () => {
  if (!cur) return; if (!navigator.geolocation) return alert('Location is not available in this browser.');
  navigator.geolocation.getCurrentPosition(p => {
    const { latitude: lat, longitude: lng } = p.coords;
    if (confirm(`Share your current location with ${cur.other.displayName}?\n\n${lat.toFixed(5)}, ${lng.toFixed(5)}`)) emit({ type: 'location', location: { lat, lng } });
  }, e => alert(e.code === 1 ? 'Location permission denied.' : e.code === 3 ? 'Location request timed out.' : 'Location unavailable.'), { timeout: 10000 });
};
$('#file').onchange = e => {
  file = e.target.files[0]; e.target.value = ''; if (!file || !cur) return;
  if (file.size > 25 * 1024 * 1024) { file = null; return alert('File too large (max 25 MB).'); }
  const pv = $('#pv'); pv.replaceChildren(); pv.classList.remove('d-none');
  const n = el(file.type.startsWith('video') ? 'video' : 'img'); n.src = URL.createObjectURL(file); n.style.maxHeight = '160px'; if (n.tagName === 'VIDEO') n.controls = true;
  const bar = el('progress'); bar.max = 100; bar.value = 0; bar.className = 'd-none w-100';
  const go = el('button', 'btn btn-sm btn-primary me-2', 'Send'), no = el('button', 'btn btn-sm btn-outline-secondary', 'Cancel');
  no.onclick = () => { file = null; pv.classList.add('d-none'); };
  go.onclick = () => { const fd = new FormData(); fd.append('clientId', crypto.randomUUID()); fd.append('file', file); const x = new XMLHttpRequest(); bar.classList.remove('d-none');
    x.open('POST', `/api/conversations/${cur.id}/media`); x.upload.onprogress = p => bar.value = p.loaded / p.total * 100;
    x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} if (x.status === 201) { add(d.message); no.onclick(); } else alert(d.error || 'Upload failed'); };
    x.onerror = () => alert('Network error during upload.'); x.send(fd); };
  pv.append(n, el('br'), bar, go, no);
};
api('/api/auth/me').then(d => start(d.user)).catch(() => {});
