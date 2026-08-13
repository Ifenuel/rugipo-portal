const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const DEFAULT_CALENDAR = {
  sessionLabel: '2025/2026 Academic Calendar',
  firstSemester: [
    { label: 'Resumption & Registration', date: '12 Jan' },
    { label: 'Matriculation Ceremony', date: '19 Feb' },
    { label: 'End of Lectures', date: '27 Feb' },
    { label: 'Semester Examinations', date: '2–20 Mar' },
    { label: 'End of First Semester', date: '15 May' }
  ],
  secondSemester: [
    { label: 'Resumption', date: '18 May' },
    { label: 'Mid-Semester Break', date: '6–10 Jul' },
    { label: 'End of Lectures', date: '14 Aug' },
    { label: 'Semester Examinations', date: '17 Aug–4 Sep' },
    { label: 'Resumption for New Session', date: '28 Sep' }
  ]
};

router.get('/', (req, res) => {
  const stored = db.get('calendar').value();
  res.json(stored || DEFAULT_CALENDAR);
});

router.put('/', requireAuth, requireRole('registrar'), (req, res) => {
  const { sessionLabel, firstSemester, secondSemester } = req.body;
  if (!sessionLabel || !Array.isArray(firstSemester) || !Array.isArray(secondSemester)) {
    return res.status(400).json({ error: 'sessionLabel, firstSemester and secondSemester (arrays) are required' });
  }
  const data = { sessionLabel, firstSemester, secondSemester };
  db.set('calendar', data).write();
  res.json(data);
});

module.exports = router;