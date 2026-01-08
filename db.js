// MongoDB helper (optional). If MONGODB_URI is not set, DB features are disabled.

const { MongoClient } = require('mongodb');

let _client = null;
let _col = null;
let _indexesReady = false;

async function getCollection() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;

  if (_col) return _col;

  _client = _client || new MongoClient(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 7000,
  });

  if (!_client.topology?.isConnected?.()) {
    await _client.connect();
  }

  const dbName = process.env.MONGODB_DB || process.env.MONGODB_DATABASE || 'lordkarma';
  const colName = process.env.MONGODB_COLLECTION || 'sessions';

  const db = _client.db(dbName);
  _col = db.collection(colName);

  if (!_indexesReady) {
    try {
      await _col.createIndex({ session_id: 1 }, { unique: true });
      // TTL index: documents will be removed when expires_at is reached.
      await _col.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    } catch (e) {
      // ignore if already exists
    }
    _indexesReady = true;
  }

  return _col;
}

module.exports = { getCollection };
