// Run this with: npm run seed
// Creates 4 placeholder staff accounts. Replace names/passwords with real
// staff details later, then delete data.json and re-run this to reset them.

const bcrypt = require('bcryptjs');
const db = require('./db');

const staffAccounts = [
  { username: 'adebayo.bursary', password: 'Bursary@2026', role: 'bursary' },
  { username: 'funke.ict',       password: 'IctAdmin@2026', role: 'ict' },
  { username: 'tunde.registrar', password: 'Registrar@2026', role: 'registrar' },
  { username: 'chioma.finance',  password: 'Finance@2026', role: 'finance' }
];

staffAccounts.forEach(acc => {
  const existing = db.get('staff').find({ username: acc.username }).value();
  if (existing) {
    console.log(`Skipped (already exists): ${acc.username}`);
    return;
  }
  const hashed = bcrypt.hashSync(acc.password, 10);
  db.get('staff').push({ username: acc.username, password: hashed, role: acc.role }).write();
  console.log(`Created staff account: ${acc.username} / ${acc.password} (role: ${acc.role})`);
});

console.log('\nDone. These are placeholder credentials — replace with real staff details later.');