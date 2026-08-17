require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { restoreFromMongo, backupToMongo } = require('./mongoBackup');

async function start() {
  await restoreFromMongo();

  const paymentsRoute = require('./routes/payments');
  const staffRoute = require('./routes/staff');
  const applicationsRoute = require('./routes/applications');
  const admittedRoute = require('./routes/admitted');
  const courseRegistrationsRoute = require('./routes/courseRegistrations');
  const courseOfferingsRoute = require('./routes/courseOfferings');
  const settingsRoute = require('./routes/settings');
  const newsRoute = require('./routes/news');
  const calendarRoute = require('./routes/calendar');

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use((req, res, next) => {
    res.on('finish', () => {
      if (req.method !== 'GET') backupToMongo();
    });
    next();
  });

  app.use('/api/payments', paymentsRoute);
  app.use('/api/staff', staffRoute);
  app.use('/api/applications', applicationsRoute);
  app.use('/api/admitted', admittedRoute);
  app.use('/api/course-registrations', courseRegistrationsRoute);
  app.use('/api/course-offerings', courseOfferingsRoute);
  app.use('/api/settings', settingsRoute);
  app.use('/api/news', newsRoute);
  app.use('/api/calendar', calendarRoute);
  app.use('/uploads/news', express.static(path.join(__dirname, 'uploads', 'news')));
  app.use('/api/results', require('./routes/results'));
  app.use('/api/transcripts', require('./routes/transcripts'));

  app.get('/', (req, res) => res.send('RUGIPO backend is running.'));

  setInterval(backupToMongo, 30000);

  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`Backend running at http://localhost:${PORT}`));
}

start();