require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || './data');
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const dbFile = path.join(dataDir, 'innofesta.json');
let db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : { sessions: [], feedback: [] };
let nextFeedbackId = db.feedback.reduce((max, item) => Math.max(max, item.id || 0), 0) + 1;
function saveDb() { fs.writeFileSync(dbFile, JSON.stringify(db, null, 2)); }

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));
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
  if (includePhotos) result.photos = row.photos.map(filename => `/api/photos/${filename}?photoId=${encodeURIComponent(row.photoId)}`);
  return result;
}
function validPhotoId(value) { return /^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(value); }
function saveDataUrl(dataUrl) {
  const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Only JPEG, PNG, and WebP images are accepted');
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const filename = `${crypto.randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(match[2], 'base64'));
  return filename;
}
function deleteFile(filename) { try { fs.unlinkSync(path.join(uploadDir, filename)); } catch (_) {} }

app.post('/api/auth/login', (req, res) => {
  if (req.body.user !== adminUser || req.body.password !== adminPass) return res.status(401).json({ error: 'Invalid admin credentials' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  res.json({ token });
});
app.post('/api/auth/logout', auth, (req, res) => { sessions.delete((req.headers.authorization || '').replace(/^Bearer\s+/i, '')); res.sendStatus(204); });

app.get('/api/sessions', auth, (req, res) => {
  res.json(db.sessions.map(row => jsonSession(row)));
});
app.post('/api/sessions', auth, (req, res) => {
  const photoId = String(req.body.photoId || '').trim().toUpperCase();
  if (!validPhotoId(photoId)) return res.status(400).json({ error: 'Invalid Photo ID' });
  const id = crypto.randomUUID();
  if (db.sessions.some(item => item.photoId === photoId)) return res.status(409).json({ error: 'That Photo ID is already in use' });
  const session = { id, photoId, notes: String(req.body.notes || ''), photos: [], createdAt: Date.now() };
  db.sessions.push(session); saveDb(); res.status(201).json(jsonSession(session));
});
app.put('/api/sessions/:id', auth, (req, res) => {
  const row = db.sessions.find(item => item.id === req.params.id);
  if (!row) return res.sendStatus(404);
  const photoId = String(req.body.photoId || row.photoId).trim().toUpperCase();
  if (!validPhotoId(photoId)) return res.status(400).json({ error: 'Invalid Photo ID' });
  try {
    if (db.sessions.some(item => item.id !== row.id && item.photoId === photoId)) return res.status(409).json({ error: 'That Photo ID is already in use' });
    row.photoId = photoId; row.notes = String(req.body.notes ?? row.notes);
    if (Array.isArray(req.body.photos)) {
      const oldPhotos = row.photos;
      row.photos = req.body.photos.map(photo => photo.startsWith('/api/photos/') ? photo.split('?')[0].split('/').pop() : saveDataUrl(photo));
      oldPhotos.filter(filename => !row.photos.includes(filename)).forEach(deleteFile);
    }
    saveDb(); res.json(jsonSession(row));
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/sessions/:id', auth, (req, res) => {
  const row = db.sessions.find(item => item.id === req.params.id);
  if (row) row.photos.forEach(deleteFile);
  db.sessions = db.sessions.filter(item => item.id !== req.params.id); saveDb();
  res.sendStatus(204);
});

app.get('/api/public/photos/:photoId', (req, res) => {
  const row = db.sessions.find(item => item.photoId === String(req.params.photoId).trim().toUpperCase());
  if (!row) return res.status(404).json({ error: 'Photo not found' });
  res.json(jsonSession(row));
});
app.get('/api/photos/:filename', (req, res) => {
  const photo = db.sessions.find(item => item.photos.includes(req.params.filename) && item.photoId === String(req.query.photoId || '').trim().toUpperCase());
  if (!photo) return res.sendStatus(404);
  res.sendFile(path.join(uploadDir, req.params.filename));
});
app.post('/api/feedback', (req, res) => {
  const rating = Math.max(1, Math.min(5, Number(req.body.rating) || 5));
  db.feedback.push({ id: nextFeedbackId++, name: String(req.body.name || ''), photoId: String(req.body.photoId || '').trim().toUpperCase(), rating, comment: String(req.body.comment || ''), createdAt: Date.now() }); saveDb();
  res.sendStatus(201);
});
app.get('/api/feedback', auth, (req, res) => {
  res.json([...db.feedback].reverse());
});

app.listen(port, () => console.log(`InnoFesta server running at http://localhost:${port}`));
