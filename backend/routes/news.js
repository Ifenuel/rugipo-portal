const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '..', 'uploads', 'news', req.newsId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname).toLowerCase());
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) return cb(new Error('INVALID_IMAGE_TYPE'));
    cb(null, true);
  }
});

function assignNewsId(req, res, next){
  req.newsId = Date.now().toString();
  next();
}

function extractYouTubeId(url){
  if (!url) return null;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

router.get('/', (req, res) => {
  res.json(db.get('news').orderBy(['date'], ['desc']).value());
});

router.get('/:id', (req, res) => {
  const record = db.get('news').find({ id: req.params.id }).value();
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
});

router.post('/', requireAuth, requireRole('ict', 'registrar'), assignNewsId, (req, res, next) => {
  upload.array('images', 12)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Each image must be under 5MB' });
      if (err.message === 'INVALID_IMAGE_TYPE') return res.status(400).json({ error: 'Only JPG, PNG, or WEBP images are allowed' });
      return res.status(400).json({ error: 'Image upload failed' });
    }
    next();
  });
}, (req, res) => {
  const { title, body, videoUrl } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const youTubeId = extractYouTubeId(videoUrl);
  if (videoUrl && !youTubeId) {
    return res.status(400).json({ error: 'Could not recognize that as a valid YouTube link. Please paste a standard youtube.com or youtu.be link.' });
  }

  const images = (req.files || []).map(f => f.filename);

  const record = {
    id: req.newsId,
    title,
    body: body || '',
    videoUrl: videoUrl || '',
    youTubeId,
    images,
    date: new Date().toISOString(),
    postedBy: req.auth.username
  };
  db.get('news').push(record).write();
  res.json(record);
});

router.delete('/:id', requireAuth, requireRole('ict', 'registrar'), (req, res) => {
  const record = db.get('news').find({ id: req.params.id }).value();
  if (record) {
    const dir = path.join(__dirname, '..', 'uploads', 'news', record.id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  db.get('news').remove({ id: req.params.id }).write();
  res.json({ success: true });
});

module.exports = router;