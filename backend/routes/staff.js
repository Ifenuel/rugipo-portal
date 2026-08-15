const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_ROLES = ['bursary', 'ict', 'registrar', 'finance', 'faculty_sci_eng', 'faculty_business', 'faculty_env_agric', 'course_officer'];
const LOGIN_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

function isStrongPassword(pw){
  return typeof pw === 'string' && pw.length >= 8 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}

function generateOfficialEmail(fullName){
  const parts = fullName.trim().toLowerCase().split(/\s+/);
  const first = parts[0] || 'staff';
  const last = parts[parts.length - 1] || 'user';
  const base = `${first}.${last}`;

  let email = `${base}@rugipo.edu.ng`;
  let n = 1;
  while (db.get('staff').find({ officialEmail: email }).value()) {
    email = `${base}${n}@rugipo.edu.ng`;
    n++;
  }
  return email;
}

function pruneOldLoginHistory(){
  const cutoff = Date.now() - LOGIN_HISTORY_RETENTION_MS;
  const kept = db.get('loginHistory').value().filter(h => new Date(h.time).getTime() >= cutoff);
  db.set('loginHistory', kept).write();
}

function logLoginAttempt(username, role, success){
  db.get('loginHistory').push({ username, role, success, time: new Date().toISOString() }).write();
  pruneOldLoginHistory();
}

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  const staff = db.get('staff').find({ username }).value();

  if (!staff) {
    logLoginAttempt(username, 'unknown', false);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const match = bcrypt.compareSync(password, staff.password);
  if (!match) {
    logLoginAttempt(username, staff.role, false);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  logLoginAttempt(username, staff.role, true);

  const token = jwt.sign(
    { username: staff.username, role: staff.role, department: staff.department || null },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({ token, username: staff.username, role: staff.role, department: staff.department || null, officialEmail: staff.officialEmail || null });
});

router.get('/login-history', requireAuth, requireRole('registrar'), (req, res) => {
  pruneOldLoginHistory();
  const history = db.get('loginHistory').orderBy(['time'], ['desc']).value();
  res.json(history);
});

// Registrar creates staff accounts
router.post('/', requireAuth, requireRole('registrar'), (req, res) => {
  const { username, password, role, department, fullName } = req.body;

  if (!username || !password || !role || !fullName) {
    return res.status(400).json({ error: 'username, password, role, and full name are required' });
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (role === 'course_officer' && !department) {
    return res.status(400).json({ error: 'A department is required for course officer accounts' });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and include both letters and numbers' });
  }

  const exists = db.get('staff').find({ username }).value();
  if (exists) {
    return res.status(400).json({ error: 'This username already exists' });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const record = {
    username,
    password: hashed,
    role,
    fullName,
    officialEmail: generateOfficialEmail(fullName),
    department: role === 'course_officer' ? department : undefined
  };

  db.get('staff').push(record).write();
  const { password: _, ...safeRecord } = record;
  res.json(safeRecord);
});

// Registrar resets a staff member's password — old password is immediately invalidated
router.put('/:username/reset-password', requireAuth, requireRole('registrar'), (req, res) => {
  const { newPassword } = req.body;
  if (!isStrongPassword(newPassword)) {
    return res.status(400).json({ error: 'New password must be at least 8 characters and include both letters and numbers' });
  }

  const staff = db.get('staff').find({ username: req.params.username }).value();
  if (!staff) return res.status(404).json({ error: 'Staff account not found' });

  const hashed = bcrypt.hashSync(newPassword, 10);
  db.get('staff').find({ username: req.params.username }).assign({ password: hashed }).write();

  res.json({ success: true });
});

router.get('/', requireAuth, requireRole('registrar'), (req, res) => {
  const all = db.get('staff').value().map(({ password, ...rest }) => rest);
  res.json(all);
});

// Staff self-service password reset via official RUGIPO email
router.post('/forgot-password', (req, res) => {
  const { username, officialEmail } = req.body;
  if (!username || !officialEmail) {
    return res.status(400).json({ error: 'Username and official email are required' });
  }

  const staff = db.get('staff').find({ username }).value();
  if (!staff || staff.officialEmail !== officialEmail.toLowerCase().trim()) {
    return res.status(400).json({ error: 'No matching staff account found for that username and email' });
  }

  const tempPassword = Math.random().toString(36).slice(-8);
  const hashed = bcrypt.hashSync(tempPassword, 10);
  db.get('staff').find({ username }).assign({ password: hashed }).write();

  res.json({ tempPassword });
});

module.exports = router;