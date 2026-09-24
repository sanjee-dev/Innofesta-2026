require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const app = express();
const port = Number(process.env.PORT || 3000);
const basePath = String(process.env.BASE_PATH || '').replace(/\/$/, '');
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseBucket = process.env.SUPABASE_BUCKET || 'innofesta-photos';
const cloudEnabled = Boolean(supabaseUrl && supabaseKey);
const dataDir = path.resolve(process.env.DATA_DIR || './data');
const uploadDir = path.join(dataDir, 'uploads');
if (!cloudEnabled) fs.mkdirSync(uploadDir, { recursive: true });
const dbFile = path.join(dataDir, 'innofesta.json');
let db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : { sessions: [], feedback: [] };
let nextFeedbackId = db.feedback.reduce((max, item) => Math.max(max, item.id || 0), 0) + 1;
function saveDb() { fs.writeFileSync(dbFile, JSON.stringify(db, null, 2)); }

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'vest.html')));
app.use(express.static(__dirname));

const sessions = new Map();
const adminUser = process.env.ADMIN_USER || 'admin';
const adminPass = process.env.ADMIN_PASS || 'change-me-before-deploying';
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Admin login required' });
  next();
}
function jsonSession(row, includePhotos = true) {
  const result = { id: row.id, photoId: row.photoId, notes: row.notes, createdAt: row.createdAt, photos: [] };
  if (includePhotos) result.photos = row.photos.map(filename => `${basePath}/api/photos/${encodeURIComponent(filename)}?photoId=${encodeURIComponent(row.photoId)}`);
  return result;
}
function validPhotoId(value) { return /^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(value); }
async function saveDataUrl(dataUrl) {
  const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Only JPEG, PNG, and WebP images are accepted');
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const filename = `${crypto.randomUUID()}.${extension}`;
  const contentType = `image/${match[1]}`;
  if (cloudEnabled) {
    const response = await fetch(`${supabaseUrl}/storage/v1/object/${supabaseBucket}/${filename}`, {
      method: 'POST', headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, 'Content-Type': contentType, 'x-upsert': 'false' },
      body: Buffer.from(match[2], 'base64')
    });
    if (!response.ok) throw new Error(`Cloud photo upload failed (${response.status})`);
  } else fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(match[2], 'base64'));
  return filename;
}
async function deleteFile(filename) {
  if (cloudEnabled) {
    await fetch(`${supabaseUrl}/storage/v1/object/${supabaseBucket}`, { method: 'DELETE', headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [filename] }) });
  } else { try { fs.unlinkSync(path.join(uploadDir, filename)); } catch (_) {} }
}
function cloudHeaders(extra = {}) { return { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, ...extra }; }
async function cloudRequest(endpoint, options = {}) {
  const response = await fetch(`${supabaseUrl}${endpoint}`, { ...options, headers: cloudHeaders({ 'Content-Type': 'application/json', ...(options.headers || {}) }) });
  if (!response.ok) throw new Error(`Cloud database request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}
async function listSessions() {
  if (!cloudEnabled) return db.sessions;
  const rows = await cloudRequest('/rest/v1/sessions?select=id,photo_id,notes,photos,created_at&order=created_at.asc');
  return rows.map(row => ({ id: row.id, photoId: row.photo_id, notes: row.notes || '', photos: row.photos || [], createdAt: row.created_at }));
}
async function listFeedback() {
  if (!cloudEnabled) return db.feedback;
  const rows = await cloudRequest('/rest/v1/feedback?select=id,name,photo_id,rating,comment,created_at&order=created_at.desc');
  return rows.map(row => ({ id: row.id, name: row.name || '', photoId: row.photo_id || '', rating: row.rating, comment: row.comment || '', createdAt: row.created_at, date: new Date(row.created_at).toLocaleString() }));
}
async function findSessionByPhotoId(photoId) { return (await listSessions()).find(item => item.photoId === photoId); }
async function findSessionById(id) { return (await listSessions()).find(item => item.id === id); }
async function saveSessionRow(row, isNew = false) {
  if (!cloudEnabled) { if (isNew) db.sessions.push(row); saveDb(); return; }
  const payload = { id: row.id, photo_id: row.photoId, notes: row.notes, photos: row.photos, created_at: row.createdAt };
  await cloudRequest(`/rest/v1/sessions${isNew ? '' : `?id=eq.${encodeURIComponent(row.id)}`}`, { method: isNew ? 'POST' : 'PATCH', headers: { Prefer: isNew ? 'return=minimal' : 'return=minimal' }, body: JSON.stringify(isNew ? payload : { photo_id: row.photoId, notes: row.notes, photos: row.photos }) });
}

app.post('/api/auth/login', (req, res) => {
  if (req.body.user !== adminUser || req.body.password !== adminPass) return res.status(401).json({ error: 'Invalid admin credentials' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  res.json({ token });
});
app.post('/api/auth/logout', auth, (req, res) => { sessions.delete((req.headers.authorization || '').replace(/^Bearer\s+/i, '')); res.sendStatus(204); });

app.get('/api/sessions', auth, async (req, res) => {
  try { res.json((await listSessions()).map(row => jsonSession(row))); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/sessions', auth, async (req, res) => {
  const photoId = String(req.body.photoId || '').trim().toUpperCase();
  if (!validPhotoId(photoId)) return res.status(400).json({ error: 'Invalid Photo ID' });
  const id = crypto.randomUUID();
  if (await findSessionByPhotoId(photoId)) return res.status(409).json({ error: 'That Photo ID is already in use' });
  const session = { id, photoId, notes: String(req.body.notes || ''), photos: [], createdAt: Date.now() };
  try { await saveSessionRow(session, true); res.status(201).json(jsonSession(session)); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.put('/api/sessions/:id', auth, async (req, res) => {
  const row = await findSessionById(req.params.id);
  if (!row) return res.sendStatus(404);
  const photoId = String(req.body.photoId || row.photoId).trim().toUpperCase();
  if (!validPhotoId(photoId)) return res.status(400).json({ error: 'Invalid Photo ID' });
  try {
    const existing = await findSessionByPhotoId(photoId);
    if (existing && existing.id !== row.id) return res.status(409).json({ error: 'That Photo ID is already in use' });
    row.photoId = photoId; row.notes = String(req.body.notes ?? row.notes);
    if (Array.isArray(req.body.photos)) {
      const oldPhotos = row.photos;
      row.photos = [];
      for (const photo of req.body.photos) row.photos.push(photo.includes('/api/photos/') ? decodeURIComponent(photo.split('?')[0].split('/').pop()) : await saveDataUrl(photo));
      await Promise.all(oldPhotos.filter(filename => !row.photos.includes(filename)).map(deleteFile));
    }
    await saveSessionRow(row); res.json(jsonSession(row));
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/sessions/:id', auth, async (req, res) => {
  const row = await findSessionById(req.params.id);
  if (row) await Promise.all(row.photos.map(deleteFile));
  if (cloudEnabled) await cloudRequest(`/rest/v1/sessions?id=eq.${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
  else { db.sessions = db.sessions.filter(item => item.id !== req.params.id); saveDb(); }
  res.sendStatus(204);
});

app.get('/api/public/photos/:photoId', async (req, res) => {
  const row = await findSessionByPhotoId(String(req.params.photoId).trim().toUpperCase());
  if (!row) return res.status(404).json({ error: 'Photo not found' });
  res.json(jsonSession(row));
});
app.get('/api/photos/:filename', async (req, res) => {
  const photo = (await listSessions()).find(item => item.photos.includes(req.params.filename) && item.photoId === String(req.query.photoId || '').trim().toUpperCase());
  if (!photo) return res.sendStatus(404);
  if (cloudEnabled) {
    const response = await fetch(`${supabaseUrl}/storage/v1/object/${supabaseBucket}/${encodeURIComponent(req.params.filename)}`, { headers: cloudHeaders() });
    if (!response.ok) return res.sendStatus(404);
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    return res.send(Buffer.from(await response.arrayBuffer()));
  }
  res.sendFile(path.join(uploadDir, req.params.filename));
});
app.post('/api/feedback', async (req, res) => {
  const rating = Math.max(1, Math.min(5, Number(req.body.rating) || 5));
  const feedback = { id: crypto.randomUUID(), name: String(req.body.name || ''), photoId: String(req.body.photoId || '').trim().toUpperCase(), rating, comment: String(req.body.comment || ''), createdAt: Date.now() };
  if (cloudEnabled) await cloudRequest('/rest/v1/feedback', { method: 'POST', body: JSON.stringify({ id: feedback.id, name: feedback.name, photo_id: feedback.photoId, rating, comment: feedback.comment, created_at: feedback.createdAt }) });
  else { feedback.id = nextFeedbackId++; db.feedback.push(feedback); saveDb(); }
  res.sendStatus(201);
});
app.get('/api/feedback', auth, async (req, res) => {
  try { res.json(await listFeedback()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.listen(port, () => console.log(`InnoFesta server running at http://localhost:${port}`));
