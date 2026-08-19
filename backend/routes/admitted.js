const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { FACULTY_MAP, FACULTY_LABELS } = require('../facultyMap');

const router = express.Router();

const ADMITTED_MANAGERS = ['registrar', 'ict'];

router.get('/verify/:regOrJamb', (req, res) => {
  const regOrJamb = req.params.regOrJamb.trim();
  const candidate = db.get('admitted_candidates').find({ regOrJamb }).value();
  if (!candidate) {
    return res.status(404).json({ error: 'This JAMB registration number was not found on the admission list. Please contact the admissions office if you believe this is an error.' });
  }
  const already = db.get('applications').find({ regOrJamb }).value();
  if (already) {
    return res.status(400).json({ error: 'A registration already exists for this JAMB number.', alreadyRegistered: true });
  }
  res.json({ admitted: true, fullName: candidate.fullName, department: candidate.department });
});

router.post('/', requireAuth, (req, res) => {
  if (!req.auth.username) return res.status(403).json({ error: 'Staff access only' });
  if (!ADMITTED_MANAGERS.includes(req.auth.role)) {
    return res.status(403).json({ error: 'Only the registrar or ICT can manage the admission list' });
  }
  const { regOrJamb, fullName, department } = req.body;
  if (!regOrJamb || !fullName || !department) {
    return res.status(400).json({ error: 'regOrJamb, fullName and department are required' });
  }
  const exists = db.get('admitted_candidates').find({ regOrJamb }).value();
  if (exists) return res.status(400).json({ error: 'This JAMB number is already on the admitted list' });

  const record = {
    id: Date.now().toString(),
    regOrJamb: regOrJamb.trim(),
    fullName, department,
    dateAdmitted: new Date().toISOString(),
    addedBy: req.auth.username
  };
  db.get('admitted_candidates').push(record).write();
  res.json(record);
});

router.post('/bulk', requireAuth, (req, res) => {
  if (!req.auth.username) return res.status(403).json({ error: 'Staff access only' });
  if (!ADMITTED_MANAGERS.includes(req.auth.role)) {
    return res.status(403).json({ error: 'Only the registrar or ICT can manage the admission list' });
  }
  const { candidates } = req.body;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return res.status(400).json({ error: 'candidates must be a non-empty array' });
  }
  const existingList = db.get('admitted_candidates').value();
  const existingSet = new Set(existingList.map(c => c.regOrJamb));
  const added = [], skipped = [];
  candidates.forEach(c => {
    if (!c.regOrJamb || !c.fullName || !c.department) { skipped.push({ ...c, reason: 'missing fields' }); return; }
    if (existingSet.has(c.regOrJamb.trim())) { skipped.push({ ...c, reason: 'already on list' }); return; }
    const record = {
      id: Date.now().toString() + Math.floor(Math.random() * 1000),
      regOrJamb: c.regOrJamb.trim(), fullName: c.fullName, department: c.department,
      dateAdmitted: new Date().toISOString(), addedBy: req.auth.username
    };
    db.get('admitted_candidates').push(record).write();
    existingSet.add(record.regOrJamb);
    added.push(record);
  });
  res.json({ addedCount: added.length, skippedCount: skipped.length, skipped });
});

// Registrar/ICT only — full unfiltered list, used for admin management
router.get('/', requireAuth, (req, res) => {
  if (!req.auth.username) return res.status(403).json({ error: 'Staff access only' });
  if (!ADMITTED_MANAGERS.includes(req.auth.role)) {
    return res.status(403).json({ error: 'Only the registrar or ICT can view the full admission list' });
  }
  res.json(db.get('admitted_candidates').value());
});

// Search by name or reg number — for ICT's search box specifically, but usable by any manager role
router.get('/search', requireAuth, (req, res) => {
  if (!req.auth.username) return res.status(403).json({ error: 'Staff access only' });
  if (!ADMITTED_MANAGERS.includes(req.auth.role)) {
    return res.status(403).json({ error: 'Only the registrar or ICT can search the admission list' });
  }
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json(db.get('admitted_candidates').value());

  const results = db.get('admitted_candidates').value().filter(c =>
    c.fullName.toLowerCase().includes(q) || c.regOrJamb.toLowerCase().includes(q)
  );
  res.json(results);
});

// registrar sees all, faculty officer sees their faculty's departments,
// course officer sees only their own department
router.get('/scoped', requireAuth, (req, res) => {
  const role = req.auth.role;
  const all = db.get('admitted_candidates').value();

  if (role === 'registrar') return res.json(all);

  if (role.startsWith('faculty_')) {
    if (!FACULTY_LABELS[role]) return res.status(403).json({ error: 'Unknown faculty role' });
    return res.json(all.filter(c => FACULTY_MAP[c.department] === role));
  }

  if (role === 'course_officer') {
    return res.json(all.filter(c => c.department === req.auth.department));
  }

  return res.status(403).json({ error: 'You do not have permission to view this' });
});

module.exports = router;