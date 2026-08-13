const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const adapter = new FileSync('data.json');
const db = low(adapter);

db.defaults({
  payments: [],
  staff: [],
  admitted_candidates: [],
  applications: [],
  loginHistory: [],
  course_registrations: [],
  course_offerings: [],
  news: [],
  settings: {
    currentSession: '2026/2027',
    feeSchedule: {
      acceptance: 25000,
      letter: 2000,
      verification: 3000,
      transcript: 5000,
      schoolFees: { ND1: 75000, ND2: 78000, HND1: 95000, HND2: 98000 }
    }
  },
  officers: [],
  calendar: null,
  results: [],
  transcript_requests: []
}).write();

module.exports = db;