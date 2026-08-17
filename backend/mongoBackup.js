const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;
const DATA_PATH = path.join(__dirname, 'data.json');
let lastSaved = null;

async function restoreFromMongo() {
  if (!MONGO_URI) {
    console.log('No MONGO_URI set — skipping restore, using local data.json as-is.');
    return;
  }
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const col = client.db('rugipo').collection('snapshots');
    const doc = await col.findOne({ _id: 'main' });
    if (doc && doc.data) {
      fs.writeFileSync(DATA_PATH, JSON.stringify(doc.data, null, 2));
      console.log('Restored data.json from MongoDB snapshot.');
    } else {
      console.log('No MongoDB snapshot found yet — starting fresh.');
    }
  } catch (err) {
    console.error('Could not restore from MongoDB:', err.message);
  } finally {
    await client.close();
  }
}

async function backupToMongo() {
  if (!MONGO_URI) return;
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    if (raw === lastSaved) return;
    const data = JSON.parse(raw);
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const col = client.db('rugipo').collection('snapshots');
    await col.updateOne({ _id: 'main' }, { $set: { data, updatedAt: new Date() } }, { upsert: true });
    await client.close();
    lastSaved = raw;
  } catch (err) {
    console.error('MongoDB backup failed:', err.message);
  }
}

module.exports = { restoreFromMongo, backupToMongo };