const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

function generateRef(){
  return 'TR' + Date.now().toString().slice(-8) + Math.floor(Math.random()*90+10);
}

router.post('/', (req, res) => {
  const { fullName, regOrJamb, email, phone, graduationYear, destinationName, destinationAddress, copies } = req.body;
  if (!fullName || !regOrJamb || !email || !phone || !graduationYear || !destinationName || !destinationAddress || !copies) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  const record = {
    id: Date.now().toString(),
    ref: generateRef(),
    fullName, regOrJamb, email, phone, graduationYear, destinationName, destinationAddress,
    copies: Number(copies),
    status: 'pending_payment',
    dateRequested: new Date().toISOString()
  };
  db.get('transcript_requests').push(record).write();
  res.json(record);
});

router.get('/lookup/:ref', (req, res) => {
  const record = db.get('transcript_requests').find({ ref: req.params.ref }).value();
  if (!record) return res.status(404).json({ error: 'No transcript request found with that reference.' });
  res.json(record);
});

// Registrar/Bursary view + manage all requests
router.get('/', requireAuth, requireRole('registrar', 'bursary'), (req, res) => {
  res.json(db.get('transcript_requests').value());
});

router.put('/:id/status', requireAuth, requireRole('registrar', 'bursary'), (req, res) => {
  const { status } = req.body;
  if (!['pending_payment','paid','processing','sent'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.get('transcript_requests').find({ id: req.params.id }).assign({ status }).write();
  res.json(db.get('transcript_requests').find({ id: req.params.id }).value());
});

module.exports = router;