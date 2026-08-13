const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/', requireAuth, (req, res) => {
  if (req.auth.role !== 'course_officer') {
    return res.status(403).json({ error: 'Only departmental course officers can manage course offerings' });
  }
  const { session, level, semester, courses } = req.body;
  if (!session || !level || !semester || !Array.isArray(courses) || courses.length === 0) {
    return res.status(400).json({ error: 'session, level, semester, and at least one course are required' });
  }
  const validCourses = courses.filter(c => c.code && c.title && c.units);
  if (validCourses.length === 0) return res.status(400).json({ error: 'Each course needs a code, title, and unit value' });

  const existing = db.get('course_offerings').find({ department: req.auth.department, session, level, semester }).value();
  if (existing) {
    db.get('course_offerings').find({ id: existing.id }).assign({
      courses: validCourses.map(c => ({ code: c.code, title: c.title, units: Number(c.units) })),
      updatedBy: req.auth.username, dateUpdated: new Date().toISOString()
    }).write();
    return res.json(db.get('course_offerings').find({ id: existing.id }).value());
  }

  const record = {
    id: Date.now().toString(),
    department: req.auth.department,
    session, level, semester,
    courses: validCourses.map(c => ({ code: c.code, title: c.title, units: Number(c.units) })),
    uploadedBy: req.auth.username,
    dateUploaded: new Date().toISOString()
  };
  db.get('course_offerings').push(record).write();
  res.json(record);
});

// Edit an existing offering by id
router.put('/:id', requireAuth, (req, res) => {
  if (req.auth.role !== 'course_officer') {
    return res.status(403).json({ error: 'Only departmental course officers can manage course offerings' });
  }
  const record = db.get('course_offerings').find({ id: req.params.id }).value();
  if (!record) return res.status(404).json({ error: 'Course offering not found' });
  if (record.department !== req.auth.department) {
    return res.status(403).json({ error: `You can only manage offerings for ${req.auth.department}` });
  }
  const { courses } = req.body;
  const validCourses = (courses || []).filter(c => c.code && c.title && c.units);
  if (validCourses.length === 0) return res.status(400).json({ error: 'At least one valid course is required' });

  db.get('course_offerings').find({ id: req.params.id }).assign({
    courses: validCourses.map(c => ({ code: c.code, title: c.title, units: Number(c.units) })),
    updatedBy: req.auth.username, dateUpdated: new Date().toISOString()
  }).write();
  res.json(db.get('course_offerings').find({ id: req.params.id }).value());
});

router.get('/', requireAuth, (req, res) => {
  if (req.auth.role === 'course_officer') {
    return res.json(db.get('course_offerings').filter({ department: req.auth.department }).value());
  }
  if (req.auth.applicationId) {
    const app = db.get('applications').find({ id: req.auth.applicationId }).value();
    if (!app) return res.status(404).json({ error: 'Application not found' });
    return res.json(db.get('course_offerings').filter({ department: app.department }).value());
  }
  return res.status(403).json({ error: 'Not authorized' });
});

module.exports = router;