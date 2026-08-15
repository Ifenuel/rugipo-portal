const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { FACULTY_MAP, FACULTY_LABELS } = require('../facultyMap');

const router = express.Router();

function generateApplicationNo(){
  return 'RUG-' + Math.floor(100000 + Math.random() * 900000);
}

// Generates a permanent matric number the moment an application is approved.
// Format: RUGIPO/{ND|HND}/{2-digit admission year}/{4-digit sequence, resets per year per level-type}
function generateMatricNo(app){
  const levelType = app.level.startsWith('ND') ? 'ND' : 'HND';
  const session = app.admissionSession || db.get('settings.currentSession').value() || '';
  const yearMatch = session.match(/(\d{4})/);
  const yy = yearMatch ? yearMatch[1].slice(2) : new Date().getFullYear().toString().slice(2);

  const counterPath = `settings.matricCounters.${yy}${levelType}`;
  const seq = (db.get(counterPath).value() || 0) + 1;
  db.set(counterPath, seq).write();

  return `RUGIPO/${levelType}/${yy}/${String(seq).padStart(4, '0')}`;
}

function canViewApplication(auth, app){
  if (auth.role === 'registrar') return true;
  if (auth.role.startsWith('faculty_')) return FACULTY_MAP[app.department] === auth.role;
  if (auth.role === 'course_officer') return app.department === auth.department;
  return false;
}

function facultyLabelFor(department){
  const key = FACULTY_MAP[department];
  return key ? FACULTY_LABELS[key] : 'Not yet assigned';
}

const SCOPED_ROLES = ['registrar', 'faculty_sci_eng', 'faculty_business', 'faculty_env_agric', 'course_officer'];

const ADDRESS_FORBIDDEN = /[,.:]/;

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png'];

const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: (req, file) => {
    const safeFolder = (req.body.regOrJamb || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
    return {
      folder: `rugipo_documents/${safeFolder}`,
      resource_type: 'auto',
      public_id: file.fieldname + '-' + Date.now()
    };
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const typeOk = ALLOWED_MIME_TYPES.includes(file.mimetype);
    const extOk = ALLOWED_EXTENSIONS.includes(ext);
    if (!typeOk || !extOk) return cb(new Error('INVALID_FILE_TYPE'));
    cb(null, true);
  }
});

const uploadFields = upload.fields([
  { name: 'jambLetter', maxCount: 1 },
  { name: 'olevel', maxCount: 1 },
  { name: 'birthCert', maxCount: 1 },
  { name: 'lga', maxCount: 1 },
  { name: 'passport', maxCount: 1 }
]);

router.get('/status/:regOrJamb', (req, res) => {
  const regOrJamb = req.params.regOrJamb.trim();

  const app = db.get('applications').find({ regOrJamb }).value();
  if (app) {
    return res.json({
      found: true,
      stage: 'registered',
      applicationNo: app.applicationNo,
      fullName: app.fullName,
      department: app.department,
      status: app.status,
      date: app.date
    });
  }

  const candidate = db.get('admitted_candidates').find({ regOrJamb }).value();
  if (candidate) {
    return res.json({
      found: true,
      stage: 'admitted_not_registered',
      fullName: candidate.fullName,
      department: candidate.department
    });
  }

  res.status(404).json({ found: false, error: 'No admission or registration record found for this JAMB number.' });
});

router.post('/', (req, res, next) => {
  uploadFields(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'One of your files is larger than 5MB' });
      if (err.message === 'INVALID_FILE_TYPE') return res.status(400).json({ error: 'Only PDF, JPG, or PNG files are allowed' });
      return res.status(400).json({ error: 'File upload failed' });
    }
    next();
  });
}, async (req, res) => {
  const { fullName, regOrJamb, email, phone, department, password, title, gender, dob, stateOfOrigin, nationality, lgaText, level, programType } = req.body;

  if (!fullName || !regOrJamb || !email || !phone || !department || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (!title || !gender || !dob || !stateOfOrigin || !nationality || !lgaText || !level || !programType) {
    return res.status(400).json({ error: 'Please select a title, gender, date of birth, state of origin, nationality, LGA, and level' });
  }
  if (!['ND1', 'ND2', 'HND1', 'HND2'].includes(level)) {
  return res.status(400).json({ error: 'Invalid level selected' });
}
if (!['full_time', 'part_time'].includes(programType)) {
  return res.status(400).json({ error: 'Invalid programme type selected' });
}
  if (!['Male', 'Female'].includes(gender)) {
    return res.status(400).json({ error: 'Gender must be Male or Female' });
  }

  const dobDate = new Date(dob);
  if (isNaN(dobDate.getTime()) || dobDate > new Date()) {
    return res.status(400).json({ error: 'Please enter a valid date of birth' });
  }
  const age = Math.floor((new Date() - dobDate) / (365.25 * 24 * 60 * 60 * 1000));
  if (age < 14 || age > 80) {
    return res.status(400).json({ error: 'Please double-check the date of birth entered' });
  }

  let nextOfKin, sponsor;
  try {
    nextOfKin = JSON.parse(req.body.nextOfKin);
    sponsor = JSON.parse(req.body.sponsor);
  } catch (e) {
    return res.status(400).json({ error: 'Next of kin and sponsor details are malformed' });
  }

  const nokFieldsOk = nextOfKin && nextOfKin.name && nextOfKin.relationship && nextOfKin.phone && nextOfKin.address;
  if (!nokFieldsOk) {
    return res.status(400).json({ error: 'Next of kin name, relationship, phone and address are required' });
  }
  if (ADDRESS_FORBIDDEN.test(nextOfKin.address)) {
    return res.status(400).json({ error: "Next of kin address cannot contain ',' ':' or '.'" });
  }

  const sponsorFieldsOk = sponsor && sponsor.name && sponsor.relationship && sponsor.phone && sponsor.occupation && sponsor.address;
  if (!sponsorFieldsOk) {
    return res.status(400).json({ error: 'Sponsor name, relationship, phone, occupation and address are required' });
  }
  if (ADDRESS_FORBIDDEN.test(sponsor.address)) {
    return res.status(400).json({ error: "Sponsor address cannot contain ',' ':' or '.'" });
  }

  if (!req.files || !req.files.jambLetter || !req.files.olevel || !req.files.birthCert || !req.files.lga || !req.files.passport) {
    return res.status(400).json({ error: 'JAMB admission letter, O\'Level result, birth certificate, state of origin/LGA certificate, and passport photo are all required' });
  }

  const passportFile = req.files.passport[0];
const MAX_PASSPORT_BYTES = 20 * 1024;
if (passportFile.size > MAX_PASSPORT_BYTES) {
  await cloudinary.uploader.destroy(passportFile.filename);
  return res.status(400).json({ error: 'Passport photograph must be smaller than 20KB. Please compress it and try again.' });
}

  const candidate = db.get('admitted_candidates').find({ regOrJamb }).value();
  if (!candidate) {
    return res.status(403).json({ error: 'This JAMB registration number is not on the admission list. Please verify your admission status first.' });
  }

  const existing = db.get('applications').find({ regOrJamb }).value();
  if (existing) {
    return res.status(400).json({ error: 'A registration already exists for this JAMB number' });
  }

  const documents = {};
['jambLetter', 'olevel', 'birthCert', 'lga', 'passport'].forEach(field => {
  if (req.files[field]) documents[field] = req.files[field][0].path;
});

  const hashed = bcrypt.hashSync(password, 10);
  const record = {
    id: Date.now().toString(),
    applicationNo: generateApplicationNo(),
    fullName, regOrJamb, email, phone, department, title, gender, dob, stateOfOrigin, nationality, lgaText, level, programType,
    admissionSession: db.get('settings.currentSession').value() || null,
    matricNo: null,
    hasSeenAdmissionMessage: false,
    password: hashed,
    documents,
    nextOfKin,
    sponsor,
    status: 'pending',
    date: new Date().toISOString()
  };
  record.faculty = facultyLabelFor(record.department);

  db.get('applications').push(record).write();

  const { password: _, ...safeRecord } = record;
  res.json(safeRecord);
});

router.post('/login', (req, res) => {
  const { regOrJamb, password } = req.body;
  if (!regOrJamb || !password) {
    return res.status(400).json({ error: 'Registration/JAMB number, matric number, or application number, and password, are required' });
  }

  const identifier = regOrJamb.trim();
  const app = db.get('applications').find(a =>
    a.regOrJamb === identifier || a.applicationNo === identifier || a.matricNo === identifier
  ).value();
  if (!app) return res.status(401).json({ error: 'Invalid login number or password' });

  const match = bcrypt.compareSync(password, app.password);
  if (!match) return res.status(401).json({ error: 'Invalid login number or password' });

  // If they logged in specifically with their JAMB reg number, check whether
  // ICT has disabled JAMB login for their whole admission session
  const usedJamb = identifier === app.regOrJamb;
  if (usedJamb && app.matricNo) {
    const disabledSessions = db.get('settings.jambDisabledSessions').value() || [];
    if (disabledSessions.includes(app.admissionSession)) {
      return res.status(401).json({
        error: `JAMB login has been disabled for your session. Please log in with your matric number: ${app.matricNo}`
      });
    }
  }

  const token = jwt.sign(
    { applicationId: app.id, regOrJamb: app.regOrJamb },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({ token, regOrJamb: app.regOrJamb, matricNo: app.matricNo || null });
});

router.post('/reset-password', (req, res) => {
  const { regOrJamb, email } = req.body;
  if (!regOrJamb || !email) {
    return res.status(400).json({ error: 'Reg/JAMB number and email are required' });
  }

  const app = db.get('applications').find({ regOrJamb: regOrJamb.trim() }).value();
  if (!app || app.email.toLowerCase() !== email.trim().toLowerCase()) {
    return res.status(404).json({ error: 'No matching record found for that reg/JAMB number and email' });
  }

  const nameParts = app.fullName.trim().split(/\s+/);
  const surname = nameParts[nameParts.length - 1].toLowerCase();
  const hashed = bcrypt.hashSync(surname, 10);

  db.get('applications').find({ id: app.id }).assign({ password: hashed }).write();

  res.json({ success: true, tempPassword: surname });
});

router.get('/me', requireAuth, (req, res) => {
  if (!req.auth.applicationId) return res.status(403).json({ error: 'Not a student token' });

  const app = db.get('applications').find({ id: req.auth.applicationId }).value();
  if (!app) return res.status(404).json({ error: 'Application not found' });

  app.faculty = facultyLabelFor(app.department);

  const { password, ...safeRecord } = app;
  res.json(safeRecord);
});

router.get('/', requireAuth, requireRole(...SCOPED_ROLES), (req, res) => {
  const all = db.get('applications').value()
    .filter(a => canViewApplication(req.auth, a))
    .map(({ password, ...rest }) => rest);
  res.json(all);
});

router.get('/:id/documents/:field', requireAuth, requireRole(...SCOPED_ROLES), (req, res) => {
  const app = db.get('applications').find({ id: req.params.id }).value();
  if (!app || !app.documents || !app.documents[req.params.field]) {
    return res.status(404).json({ error: 'Document not found' });
  }
  if (!canViewApplication(req.auth, app)) {
    return res.status(403).json({ error: "You do not have permission to view this applicant's documents" });
  }

  res.redirect(app.documents[req.params.field]);
});

router.put('/:id/status', requireAuth, (req, res) => {
  if (!req.auth.username) return res.status(403).json({ error: 'Staff access only' });
  if (req.auth.role !== 'registrar') {
    return res.status(403).json({ error: 'Only the registrar can change admission status' });
  }

  const { status } = req.body;
  const app = db.get('applications').find({ id: req.params.id }).value();
  if (!app) return res.status(404).json({ error: 'Application not found' });

  const updates = { status };
  if (status === 'approved' && !app.matricNo) {
    updates.matricNo = generateMatricNo(app);
  }

  db.get('applications').find({ id: req.params.id }).assign(updates).write();
  res.json({ success: true, matricNo: updates.matricNo || app.matricNo || null });
});

router.put('/bulk/status', requireAuth, (req, res) => {
  if (!req.auth.username) return res.status(403).json({ error: 'Staff access only' });
  if (req.auth.role !== 'registrar') {
    return res.status(403).json({ error: 'Only the registrar can change admission status' });
  }

  const { ids, status } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved or rejected' });
  }

  let updated = 0;
  ids.forEach(id => {
    const app = db.get('applications').find({ id }).value();
    if (app) {
      const updates = { status };
      if (status === 'approved' && !app.matricNo) {
        updates.matricNo = generateMatricNo(app);
      }
      db.get('applications').find({ id }).assign(updates).write();
      updated++;
    }
  });

  res.json({ success: true, updated });
});

router.put('/mark-admission-seen', requireAuth, (req, res) => {
  if (!req.auth.applicationId) return res.status(403).json({ error: 'Not a student token' });
  db.get('applications').find({ id: req.auth.applicationId }).assign({ hasSeenAdmissionMessage: true }).write();
  res.json({ success: true });
});

router.get('/stats/faculty', requireAuth, (req, res) => {
  const role = req.auth.role;
  const approved = db.get('applications').value().filter(a => a.status === 'approved');

  function countFor(facultyKey) {
    const inFaculty = approved.filter(a => FACULTY_MAP[a.department] === facultyKey);
    return {
      faculty: FACULTY_LABELS[facultyKey],
      total: inFaculty.length,
      male: inFaculty.filter(a => a.gender === 'Male').length,
      female: inFaculty.filter(a => a.gender === 'Female').length
    };
  }

  if (role === 'registrar') {
    return res.json(Object.keys(FACULTY_LABELS).map(countFor));
  }
  if (role.startsWith('faculty_')) {
    if (!FACULTY_LABELS[role]) return res.status(403).json({ error: 'Unknown faculty role' });
    return res.json([countFor(role)]);
  }
  return res.status(403).json({ error: 'You do not have permission to view this' });
});

router.get('/faculty-list', requireAuth, (req, res) => {
  const role = req.auth.role;
  const approved = db.get('applications').value()
    .filter(a => a.status === 'approved')
    .map(({ password, ...rest }) => rest);

  if (role === 'registrar') return res.json(approved);

  if (role.startsWith('faculty_')) {
    if (!FACULTY_LABELS[role]) return res.status(403).json({ error: 'Unknown faculty role' });
    return res.json(approved.filter(a => FACULTY_MAP[a.department] === role));
  }

  if (role === 'course_officer') {
    return res.json(approved.filter(a => a.department === req.auth.department));
  }

  return res.status(403).json({ error: 'You do not have permission to view this' });
});

router.get('/me/photo', requireAuth, (req, res) => {
  if (!req.auth.applicationId) return res.status(403).json({ error: 'Not a student token' });

  const app = db.get('applications').find({ id: req.auth.applicationId }).value();
  if (!app) return res.status(404).json({ error: 'Application not found' });

  const passportUrl = app.documents?.passport;
  if (!passportUrl) return res.status(404).json({ error: 'Passport photograph not found' });

  res.redirect(passportUrl);
});

// Distinct admission sessions with student counts and JAMB-login status — for ICT's toggle panel
router.get('/admission-sessions', requireAuth, requireRole('registrar', 'ict'), (req, res) => {
  const all = db.get('applications').value();
  const disabledSessions = db.get('settings.jambDisabledSessions').value() || [];

  const bySession = {};
  all.forEach(a => {
    const session = a.admissionSession || 'Unspecified';
    if (!bySession[session]) bySession[session] = 0;
    bySession[session]++;
  });

  res.json(Object.keys(bySession).map(session => ({
    session,
    studentCount: bySession[session],
    jambDisabled: disabledSessions.includes(session)
  })));
});

// ICT (or Registrar) flips JAMB login off/on for an entire admission session at once
router.put('/jamb-toggle', requireAuth, requireRole('registrar', 'ict'), (req, res) => {
  const { session, disabled } = req.body;
  if (!session) return res.status(400).json({ error: 'session is required' });

  let disabledSessions = db.get('settings.jambDisabledSessions').value() || [];
  if (disabled) {
    if (!disabledSessions.includes(session)) disabledSessions.push(session);
  } else {
    disabledSessions = disabledSessions.filter(s => s !== session);
  }
  db.set('settings.jambDisabledSessions', disabledSessions).write();
  res.json({ session, disabled: !!disabled });
});

const CORRECTABLE_FIELDS = ['fullName', 'email', 'phone', 'nextOfKin', 'sponsor'];
const SEARCH_ROLES = ['registrar', 'faculty_sci_eng', 'faculty_business', 'faculty_env_agric', 'course_officer', 'ict'];

function canSearchApplication(auth, app){
  if (auth.role === 'ict') return true; // ICT can view any student for support purposes
  return canViewApplication(auth, app);
}

// Search by name, JAMB reg, matric no, or application no — scoped by role
router.get('/search', requireAuth, requireRole(...SEARCH_ROLES), (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);

  const results = db.get('applications').value()
    .filter(a => canSearchApplication(req.auth, a))
    .filter(a =>
      a.fullName.toLowerCase().includes(q) ||
      a.regOrJamb.toLowerCase().includes(q) ||
      (a.matricNo && a.matricNo.toLowerCase().includes(q)) ||
      a.applicationNo.toLowerCase().includes(q)
    )
    .map(({ password, ...rest }) => rest);

  res.json(results);
});

// ICT or Registrar can correct contact/bio-data fields only — never status, department, level, matricNo, regOrJamb
router.put('/:id/correct', requireAuth, requireRole('registrar', 'ict'), (req, res) => {
  const app = db.get('applications').find({ id: req.params.id }).value();
  if (!app) return res.status(404).json({ error: 'Application not found' });

  const updates = {};
  CORRECTABLE_FIELDS.forEach(field => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No correctable fields were provided' });
  }

  if (updates.nextOfKin) {
    const nok = updates.nextOfKin;
    if (!nok.name || !nok.relationship || !nok.phone || !nok.address) {
      return res.status(400).json({ error: 'Next of kin name, relationship, phone and address are required' });
    }
    if (ADDRESS_FORBIDDEN.test(nok.address)) {
      return res.status(400).json({ error: "Next of kin address cannot contain ',' ':' or '.'" });
    }
  }
  if (updates.sponsor) {
    const sp = updates.sponsor;
    if (!sp.name || !sp.relationship || !sp.phone || !sp.occupation || !sp.address) {
      return res.status(400).json({ error: 'Sponsor name, relationship, phone, occupation and address are required' });
    }
    if (ADDRESS_FORBIDDEN.test(sp.address)) {
      return res.status(400).json({ error: "Sponsor address cannot contain ',' ':' or '.'" });
    }
  }

  db.get('applications').find({ id: req.params.id }).assign(updates).write();
  const updated = db.get('applications').find({ id: req.params.id }).value();
  updated.faculty = facultyLabelFor(updated.department);
  const { password, ...safeRecord } = updated;
  res.json(safeRecord);
});

// Registrar can rename/reassign an admission session label — e.g. fixing "Unspecified"
// batches into a real session name like "2025/2026".
router.put('/assign-session', requireAuth, requireRole('registrar'), (req, res) => {
  const { fromSession, toSession } = req.body;
  if (!toSession) return res.status(400).json({ error: 'toSession is required' });

  const normalizedFrom = fromSession === 'Unspecified' ? null : fromSession;

  const all = db.get('applications').value();
  let updated = 0;
  all.forEach(a => {
    const current = a.admissionSession || null;
    if (current === normalizedFrom) {
      db.get('applications').find({ id: a.id }).assign({ admissionSession: toSession }).write();
      updated++;
    }
  });

  const disabledSessions = db.get('settings.jambDisabledSessions').value() || [];
  if (disabledSessions.includes(fromSession)) {
    const withoutOld = disabledSessions.filter(s => s !== fromSession);
    withoutOld.push(toSession);
    db.set('settings.jambDisabledSessions', withoutOld).write();
  }

  res.json({ updated, toSession });
});

module.exports = router;