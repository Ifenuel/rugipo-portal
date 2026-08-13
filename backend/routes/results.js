const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

const LEVEL_ORDER = { ND1: 1, ND2: 2, HND1: 3, HND2: 4 };
const SEMESTER_ORDER = { First: 1, Second: 2 };

function gradeFromScore(score){
  if (score >= 70) return { grade: 'A', point: 5 };
  if (score >= 60) return { grade: 'B', point: 4 };
  if (score >= 50) return { grade: 'C', point: 3 };
  if (score >= 45) return { grade: 'D', point: 2 };
  if (score >= 40) return { grade: 'E', point: 1 };
  return { grade: 'F', point: 0 };
}

// Course Officer uploads/updates a result for one student, one session/level/semester
router.post('/', requireAuth, (req, res) => {
  if (req.auth.role !== 'course_officer') {
    return res.status(403).json({ error: 'Only departmental course officers can upload results' });
  }
  const { regOrJamb, session, level, semester, scores } = req.body;
  if (!regOrJamb || !session || !level || !semester || !Array.isArray(scores) || scores.length === 0) {
    return res.status(400).json({ error: 'regOrJamb, session, level, semester, and at least one score are required' });
  }

  const app = db.get('applications').find(a => a.regOrJamb === regOrJamb || a.matricNo === regOrJamb).value();
  if (!app) return res.status(404).json({ error: 'No student found with that registration number' });
  if (app.department !== req.auth.department) {
    return res.status(403).json({ error: `You can only upload results for students in ${req.auth.department}` });
  }

  // Pull the officer's own uploaded course list for this session/level/semester —
  // never trust course titles/units coming from the client
  const offering = db.get('course_offerings')
    .find({ department: req.auth.department, session, level, semester }).value();
  if (!offering) {
    return res.status(400).json({ error: 'No course list has been uploaded for this session/level/semester yet. Upload the course list first.' });
  }

  let totalUnits = 0, totalPoints = 0;
  const gradedScores = scores.map(s => {
    const course = offering.courses.find(c => c.code === s.code);
    const units = course ? Number(course.units) : 0;
    const scoreNum = Number(s.score);
    const { grade, point } = gradeFromScore(scoreNum);
    totalUnits += units;
    totalPoints += point * units;
    return { code: s.code, title: course ? course.title : '', units, score: scoreNum, grade, point };
  });

  const gpa = totalUnits > 0 ? +(totalPoints / totalUnits).toFixed(2) : 0;

  const existing = db.get('results').find({ regOrJamb, session, semester }).value();
  const record = {
    id: existing ? existing.id : Date.now().toString(),
    regOrJamb, fullName: app.fullName, department: app.department,
    session, level, semester,
    scores: gradedScores,
    totalUnits, totalPoints, gpa,
    uploadedBy: req.auth.username,
    dateUploaded: new Date().toISOString()
  };

  if (existing) db.get('results').find({ id: existing.id }).assign(record).write();
  else db.get('results').push(record).write();

  res.json(record);
});

// Course officer viewing all results they've uploaded for their department
router.get('/', requireAuth, (req, res) => {
  if (req.auth.role !== 'course_officer') return res.status(403).json({ error: 'Only course officers can view this' });
  res.json(db.get('results').filter({ department: req.auth.department }).value());
});

// Student's own results, in correct academic order, with running CGPA
router.get('/me', requireAuth, (req, res) => {
  if (!req.auth.applicationId) return res.status(403).json({ error: 'Not a student token' });
  const app = db.get('applications').find({ id: req.auth.applicationId }).value();
  if (!app) return res.status(404).json({ error: 'Application not found' });

  const results = db.get('results').filter({ regOrJamb: app.regOrJamb }).value();

  const sorted = results.slice().sort((a, b) => {
    if (a.session !== b.session) return a.session.localeCompare(b.session);
    const levelDiff = (LEVEL_ORDER[a.level] || 0) - (LEVEL_ORDER[b.level] || 0);
    if (levelDiff !== 0) return levelDiff;
    return (SEMESTER_ORDER[a.semester] || 0) - (SEMESTER_ORDER[b.semester] || 0);
  });

  let cumUnits = 0, cumPoints = 0;
  const withCgpa = sorted.map(r => {
    cumUnits += r.totalUnits;
    cumPoints += r.totalPoints;
    return { ...r, cgpa: cumUnits > 0 ? +(cumPoints / cumUnits).toFixed(2) : 0 };
  });

  res.json(withCgpa);
});

module.exports = router;