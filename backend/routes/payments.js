const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateRemitaRRR, checkRemitaStatus } = require('../remita');

const router = express.Router();

const FEE_LABELS = {
  acceptance: 'Acceptance Fee',
  letter: 'Admission Letter',
  verification: 'Result Verification',
  transcript: 'Transcript Request'
};

function getFeeSchedule(){
  return db.get('settings.feeSchedule').value() || {};
}

function getHostels(){
  return db.get('settings.feeSchedule.hostels').value() || {};
}

router.get('/hostels', (req, res) => {
  const hostels = getHostels();
  res.json(Object.keys(hostels).map(key => ({ key, label: hostels[key].label, amount: hostels[key].amount })));
});

function findApplication(reg){
  return db.get('applications').find({ regOrJamb: reg }).value();
}

function findAdmittedCandidate(reg){
  return db.get('admitted_candidates').find({ regOrJamb: reg }).value();
}

function emailsMatch(a, b){
  return typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function alreadyPaid(reg, purpose){
  return db.get('payments').find(p => p.reg === reg && p.purpose === purpose && p.status === 'paid').value();
}

// Public: lets pay.html show a student's exact school fee before they generate an RRR
router.get('/my-level/:reg', (req, res) => {
  const app = findApplication(req.params.reg);
  if (!app) return res.status(404).json({ error: 'No application found for that registration number.' });
  if (app.status !== 'approved') return res.status(403).json({ error: 'Your admission has not been approved yet.' });

  const fees = getFeeSchedule();
  const programType = app.programType || 'full_time';
  const amount = fees.schoolFees?.[programType]?.[app.level] || null;

  res.json({ level: app.level, programType, amount });
});

router.post('/', async (req, res) => {
  const { name, reg, email, phone, feeType } = req.body;
  if (!name || !reg || !email || !phone || !feeType) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const fees = getFeeSchedule();
  let amount, purpose, level = null, department = null, programType = null;

  if (feeType.startsWith('hostel_')) {
    const hostels = getHostels();
    const h = hostels[feeType];
    if (!h) return res.status(400).json({ error: 'Invalid hostel selection' });

    const app = findApplication(reg);
    if (!app) return res.status(403).json({ error: 'No admission record found for this registration number.' });
    if (app.status !== 'approved') {
      return res.status(403).json({ error: 'Your admission must be approved by the Registrar before you can pay for hostel accommodation.' });
    }
    if (!emailsMatch(app.email, email)) {
      return res.status(403).json({ error: 'The email you entered does not match our records for this registration number.' });
    }
    amount = h.amount; purpose = h.label;
    level = app.level;
    department = app.department;
    programType = app.programType || 'full_time';

  } else if (feeType === 'schoolfees') {
    const app = findApplication(reg);
    if (!app) return res.status(403).json({ error: 'No admission record found for this registration number.' });
    if (app.status !== 'approved') {
      return res.status(403).json({ error: 'Your admission must be approved by the Registrar before you can pay school fees.' });
    }
    if (!emailsMatch(app.email, email)) {
      return res.status(403).json({ error: 'The email you entered does not match our records for this registration number.' });
    }
    department = app.department;
    programType = app.programType || 'full_time';
    if (!app.level || !fees.schoolFees?.[programType]?.[app.level]) {
      return res.status(400).json({ error: 'Your application record is missing a valid level, or the fee schedule has not been set for it. Contact the registrar\'s office.' });
    }
    amount = fees.schoolFees[programType][app.level];
    purpose = `School Fees — ${app.level}`;
    level = app.level;

  } else if (feeType === 'letter' || feeType === 'verification') {
    const app = findApplication(reg);
    if (!app) return res.status(403).json({ error: 'No admission record found for this registration number.' });
    if (!emailsMatch(app.email, email)) {
      return res.status(403).json({ error: 'The email you entered does not match our records for this registration number.' });
    }
    if (!fees[feeType]) return res.status(400).json({ error: 'This fee has not been configured yet. Contact the registrar\'s office.' });
    amount = fees[feeType]; purpose = FEE_LABELS[feeType];
    level = app.level;
    department = app.department;
    programType = app.programType || 'full_time';

  } else if (feeType === 'acceptance') {
    const app = findApplication(reg);
    if (app) {
      if (!emailsMatch(app.email, email)) {
        return res.status(403).json({ error: 'The email you entered does not match our records for this registration number.' });
      }
      level = app.level;
      department = app.department;
      programType = app.programType || 'full_time';
    } else {
      const candidate = findAdmittedCandidate(reg);
      if (!candidate) {
        return res.status(403).json({ error: 'This registration number was not found on the admission list.' });
      }
    }
    if (!fees.acceptance) return res.status(400).json({ error: 'Acceptance fee has not been configured yet. Contact the registrar\'s office.' });
    amount = fees.acceptance; purpose = FEE_LABELS.acceptance;

  } else if (feeType === 'transcript') {
    if (!fees.transcript) return res.status(400).json({ error: 'Transcript fee has not been configured yet. Contact the registrar\'s office.' });
    amount = fees.transcript; purpose = FEE_LABELS.transcript;

  } else {
    return res.status(400).json({ error: 'Invalid fee type' });
  }

  const existingPaid = alreadyPaid(reg, purpose);
  if (existingPaid) {
    return res.status(400).json({ error: `You have already paid for ${purpose}. Check your payment history to view or print the receipt.` });
  }

  try {
    const remitaResponse = await generateRemitaRRR({ amount, payerName: name, payerEmail: email, payerPhone: phone, description: purpose });
    const rrr = remitaResponse.RRR || remitaResponse.rrr;
    if (!rrr) return res.status(502).json({ error: 'Could not generate a reference number', details: remitaResponse });

    const record = { rrr, name, reg, email, phone, purpose, amount, status: 'pending', method: null, date: new Date().toISOString(), level, department, programType };
    db.get('payments').push(record).write();
    res.json(record);
  } catch (err) {
    console.error('Payment generation failed:', err.message);
    res.status(502).json({ error: 'Could not generate payment reference. Try again shortly.' });
  }
});

router.put('/:rrr/complete', async (req, res) => {
  const { method } = req.body;
  const rrr = req.params.rrr;
  const record = db.get('payments').find({ rrr }).value();
  if (!record) return res.status(404).json({ error: 'Payment not found' });

  try {
    const statusResponse = await checkRemitaStatus(rrr);
    const paid = statusResponse.status === '00' || statusResponse.status === '01';
    if (!paid) {
      return res.status(402).json({ error: 'Payment not confirmed yet', remitaStatus: statusResponse.statusmessage || statusResponse.status });
    }
    db.get('payments').find({ rrr }).assign({ status: 'paid', method }).write();
    res.json(db.get('payments').find({ rrr }).value());
  } catch (err) {
    console.error('Payment status check failed:', err.message);
    res.status(502).json({ error: 'Could not confirm payment status. Try again shortly.' });
  }
});

router.get('/lookup/:query', (req, res) => {
  const q = req.params.query.toLowerCase().replace(/\s/g, '');
  const match = db.get('payments').find(p => p.rrr.replace(/\s/g, '').toLowerCase() === q || p.reg.toLowerCase() === q).value();
  if (!match) return res.status(404).json({ error: 'No record found' });
  res.json(match);
});

router.get('/check-letter/:reg', (req, res) => {
  const reg = req.params.reg.toLowerCase();
  const match = db.get('payments').find(p => p.reg.toLowerCase() === reg && p.purpose === 'Admission Letter' && p.status === 'paid').value();
  res.json({ paid: !!match });
});

router.get('/my-history', requireAuth, (req, res) => {
  if (!req.auth.regOrJamb) return res.status(403).json({ error: 'Not a student token' });
  const history = db.get('payments').filter(p => p.reg === req.auth.regOrJamb).orderBy(['date'], ['desc']).value();
  res.json(history);
});

router.get('/', requireAuth, requireRole('bursary', 'finance'), (req, res) => {
  res.json(db.get('payments').orderBy(['date'], ['desc']).value());
});

router.get('/school-fees', (req, res) => {
  const fees = getFeeSchedule();
  res.json(fees.schoolFees || {});
});

router.get('/fee-schedule', (req, res) => {
  const fees = getFeeSchedule();
  res.json({
    acceptance: fees.acceptance || 0,
    letter: fees.letter || 0,
    verification: fees.verification || 0,
    transcript: fees.transcript || 0,
    schoolFees: fees.schoolFees || {}
  });
});

module.exports = router;