const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function getEligibility(app) {
  const payments = db.get('payments').filter(p => p.reg === app.regOrJamb && p.status === 'paid').value();
  const paidPurposes = new Set(payments.map(p => p.purpose));

  const hasAcceptance = paidPurposes.has('Acceptance Fee');
  const hasLetter = paidPurposes.has('Admission Letter');
  const hasSchoolFee = paidPurposes.has(`School Fees — ${app.level}`);

  const priorRegistrations = db.get('course_registrations').filter({ regOrJamb: app.regOrJamb }).value();
  const isNewStudent = priorRegistrations.length === 0;

  const missing = [];
  if (isNewStudent) {
    if (!hasAcceptance) missing.push('Acceptance Fee');
    if (!hasSchoolFee) missing.push('School Fees');
  } else if (!hasSchoolFee) {
    missing.push('School Fees');
  }

  return { eligible: missing.length === 0, isNewStudent, missing };
}

router.get('/eligibility', requireAuth, (req, res) => {
  if (!req.auth.applicationId) return res.status(403).json({ error: 'Not a student token' });
  const app = db.get('applications').find({ id: req.auth.applicationId }).value();
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (app.status !== 'approved') {
    return res.json({ eligible: false, isNewStudent: true, missing: ['Admission approval'] });
  }
  res.json(getEligibility(app));
});

// Student registers courses — restricted to their OWN level's offering only, no lower levels visible
router.post('/', requireAuth, (req, res) => {
  if (!req.auth.applicationId) return res.status(403).json({ error: 'Only students can register their own courses' });

  const app = db.get('applications').find({ id: req.auth.applicationId }).value();
  if (!app || app.status !== 'approved') {
    return res.status(400).json({ error: 'You must be an approved admission to register courses' });
  }

  const elig = getEligibility(app);
  if (!elig.eligible) {
    return res.status(403).json({ error: `Please complete payment first: ${elig.missing.join(', ')}` });
  }

  const { session, level, semester, courses } = req.body;
  if (!session || !level || !semester || !Array.isArray(courses) || courses.length === 0) {
    return res.status(400).json({ error: 'session, level, semester, and at least one selected course are required' });
  }

  const currentSession = (db.get('settings').value() || {}).currentSession;
  if (currentSession && session !== currentSession) {
    return res.status(400).json({ error: `Course registration is only open for the current session (${currentSession}).` });
  }

  const offering = db.get('course_offerings').find({ department: app.department, session, level, semester }).value();
  if (!offering) {
    return res.status(400).json({ error: 'No course list has been uploaded for your level, session and semester yet. Contact your course officer.' });
  }
  const validCodes = new Set(offering.courses.map(c => c.code));

  const selected = courses.filter(c => validCodes.has(c.code));
  if (selected.length === 0) {
    return res.status(400).json({ error: 'Selected courses do not match the course list for your level' });
  }

  const existing = db.get('course_registrations').find({ regOrJamb: app.regOrJamb, session, semester }).value();
  if (existing) {
    return res.status(400).json({ error: 'You have already registered courses for this session and semester' });
  }

  const finalCourses = selected.map(c => ({ code: c.code, title: c.title, units: Number(c.units) }));
  const totalUnits = finalCourses.reduce((s, c) => s + c.units, 0);

  const record = {
    id: Date.now().toString(),
    regOrJamb: app.regOrJamb,
    fullName: app.fullName,
    department: app.department,
    session, level, semester,
    courses: finalCourses,
    totalUnits,
    status: 'pending',
    dateUploaded: new Date().toISOString(),
    approvedBy: null,
    dateApproved: null
  };

  db.get('course_registrations').push(record).write();
  res.json(record);
});

// Course officer: add a carryover (or any extra) course to a student's still-pending form
router.put('/:id/add-course', requireAuth, (req, res) => {
  if (req.auth.role !== 'course_officer') {
    return res.status(403).json({ error: 'Only departmental course officers can edit course registration forms' });
  }
  const record = db.get('course_registrations').find({ id: req.params.id }).value();
  if (!record) return res.status(404).json({ error: 'Course registration not found' });
  if (record.department !== req.auth.department) {
    return res.status(403).json({ error: `You can only manage students in ${req.auth.department}` });
  }
  if (record.status === 'approved') {
    return res.status(400).json({ error: 'This form has already been approved and can no longer be edited. Contact the registrar to reverse it if needed.' });
  }

  const { code, title, units } = req.body;
  if (!code || !title || !units) {
    return res.status(400).json({ error: 'code, title, and units are required to add a course' });
  }
  if (record.courses.some(c => c.code === code)) {
    return res.status(400).json({ error: 'This course is already on the student\'s form' });
  }

  const updatedCourses = [...record.courses, { code, title, units: Number(units) }];
  const totalUnits = updatedCourses.reduce((s, c) => s + c.units, 0);

  db.get('course_registrations').find({ id: req.params.id }).assign({ courses: updatedCourses, totalUnits }).write();
  res.json(db.get('course_registrations').find({ id: req.params.id }).value());
});

// Course officer: remove a course from a still-pending form (e.g. mistaken carryover entry)
router.put('/:id/remove-course', requireAuth, (req, res) => {
  if (req.auth.role !== 'course_officer') {
    return res.status(403).json({ error: 'Only departmental course officers can edit course registration forms' });
  }
  const record = db.get('course_registrations').find({ id: req.params.id }).value();
  if (!record) return res.status(404).json({ error: 'Course registration not found' });
  if (record.department !== req.auth.department) {
    return res.status(403).json({ error: `You can only manage students in ${req.auth.department}` });
  }
  if (record.status === 'approved') {
    return res.status(400).json({ error: 'This form has already been approved and can no longer be edited' });
  }

  const { code } = req.body;
  const updatedCourses = record.courses.filter(c => c.code !== code);
  if (updatedCourses.length === 0) {
    return res.status(400).json({ error: 'A course form must have at least one course' });
  }
  const totalUnits = updatedCourses.reduce((s, c) => s + c.units, 0);

  db.get('course_registrations').find({ id: req.params.id }).assign({ courses: updatedCourses, totalUnits }).write();
  res.json(db.get('course_registrations').find({ id: req.params.id }).value());
});

router.put('/:id/approve', requireAuth, (req, res) => {
  if (req.auth.role !== 'course_officer') {
    return res.status(403).json({ error: 'Only departmental course officers can approve course registration forms' });
  }
  const record = db.get('course_registrations').find({ id: req.params.id }).value();
  if (!record) return res.status(404).json({ error: 'Course registration not found' });
  if (record.department !== req.auth.department) {
    return res.status(403).json({ error: `You can only manage students in ${req.auth.department}` });
  }

  db.get('course_registrations').find({ id: req.params.id }).assign({
    status: 'approved',
    approvedBy: req.auth.username,
    dateApproved: new Date().toISOString()
  }).write();

  res.json(db.get('course_registrations').find({ id: req.params.id }).value());
});

// Course registration data belongs to the course officer alone — the registrar does not
// need day-to-day visibility into this operational workflow.
router.get('/', requireAuth, (req, res) => {
  if (req.auth.role === 'course_officer') {
    return res.json(db.get('course_registrations').filter({ department: req.auth.department }).value());
  }
  return res.status(403).json({ error: 'Only course officers can view course registration records' });
});

router.get('/me', requireAuth, (req, res) => {
  if (!req.auth.applicationId) return res.status(403).json({ error: 'Not a student token' });
  const app = db.get('applications').find({ id: req.auth.applicationId }).value();
  if (!app) return res.status(404).json({ error: 'Application not found' });
  res.json(db.get('course_registrations').filter({ regOrJamb: app.regOrJamb }).value());
});

module.exports = router;