const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const multer = require('multer');
const fs = require('fs');
const path = require('path');

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const officerUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '..', 'uploads', 'officers');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname).toLowerCase());
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) return cb(new Error('INVALID_IMAGE_TYPE'));
    cb(null, true);
  }
});

const router = express.Router();

router.get('/current-session', (req, res) => {
  const s = db.get('settings').value() || {};
  res.json({ currentSession: s.currentSession || '' });
});

router.put('/current-session', requireAuth, requireRole('registrar'), (req, res) => {
  const { currentSession } = req.body;
  if (!currentSession) return res.status(400).json({ error: 'currentSession is required' });
  db.set('settings.currentSession', currentSession).write();
  res.json({ currentSession });
});

// Public: what the homepage button should say and whether it's clickable
router.get('/admission-status', (req, res) => {
  const s = db.get('settings').value() || {};
  res.json(s.admission || { label: 'Registration Now Open', active: true });
});

// Registrar only: controls the homepage admission/registration banner
router.put('/admission-status', requireAuth, requireRole('registrar'), (req, res) => {
  const { label, active } = req.body;
  if (!label) return res.status(400).json({ error: 'label is required' });
  const data = { label, active: !!active };
  db.set('settings.admission', data).write();
  res.json(data);
});

const LEVEL_PROGRESSION = { ND1: 'ND2', ND2: 'HND1', HND1: 'HND2', HND2: null };

router.put('/advance-session', requireAuth, requireRole('registrar'), (req, res) => {
  const { newSession } = req.body;
  if (!newSession) return res.status(400).json({ error: 'newSession is required' });

  const approvedApps = db.get('applications').filter({ status: 'approved' }).value();
  let promoted = 0, graduated = 0;
  approvedApps.forEach(app => {
    const nextLevel = LEVEL_PROGRESSION[app.level];
    if (nextLevel) {
      db.get('applications').find({ id: app.id }).assign({ level: nextLevel }).write();
      promoted++;
    } else if (app.level === 'HND2') {
      db.get('applications').find({ id: app.id }).assign({ status: 'graduated' }).write();
      graduated++;
    }
  });

  db.set('settings.currentSession', newSession).write();
  res.json({ currentSession: newSession, promoted, graduated });
});

router.get('/fees', (req, res) => {
  res.json(db.get('settings.feeSchedule').value() || {});
});

router.put('/fees', requireAuth, requireRole('registrar'), (req, res) => {
  const { acceptance, letter, verification, transcript, schoolFees, hostels } = req.body;
  if (!acceptance || !letter || !verification || !transcript) {
    return res.status(400).json({ error: 'Acceptance, letter, verification, and transcript fees are required' });
  }
  if (!schoolFees || !schoolFees.full_time || !schoolFees.part_time) {
    return res.status(400).json({ error: 'School fees must include both Full-Time and Part-Time amounts' });
  }
  const requiredLevels = ['ND1', 'ND2', 'HND1', 'HND2'];
  for (const mode of ['full_time', 'part_time']) {
    for (const lvl of requiredLevels) {
      if (!schoolFees[mode][lvl]) {
        return res.status(400).json({ error: `Missing ${mode === 'full_time' ? 'Full-Time' : 'Part-Time'} fee for ${lvl}` });
      }
    }
  }
  db.set('settings.feeSchedule', { acceptance, letter, verification, transcript, schoolFees, hostels: hostels || {} }).write();
  res.json(db.get('settings.feeSchedule').value());
});

router.get('/officers', (req, res) => {
  res.json(db.get('officers').value());
});

router.put('/officers', requireAuth, requireRole('registrar'), (req, res) => {
  const { officers } = req.body;
  if (!Array.isArray(officers)) return res.status(400).json({ error: 'officers must be an array' });
  db.set('officers', officers).write();
  res.json(db.get('officers').value());
});

// Registrar or ICT uploads a single officer photo, gets back a filename to attach to that officer's record
router.post('/officer-photo', requireAuth, requireRole('registrar', 'ict'), (req, res) => {
  officerUpload.single('photo')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Photo must be under 3MB' });
      if (err.message === 'INVALID_IMAGE_TYPE') return res.status(400).json({ error: 'Only JPG, PNG, or WEBP images are allowed' });
      return res.status(400).json({ error: 'Photo upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No photo received' });
    res.json({ filename: req.file.filename });
  });
});

router.get('/ticker', (req, res) => {
  res.json(db.get('settings.ticker').value() || []);
});

router.put('/ticker', requireAuth, requireRole('registrar', 'ict'), (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array of strings' });
  db.set('settings.ticker', messages).write();
  res.json(db.get('settings.ticker').value());
});

module.exports = router;