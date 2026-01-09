"use strict";

const { MongoClient } = require("mongodb");

let _client = null;
let _col = null;

/**
 * Returns a MongoDB collection when MONGODB_URI is provided.
 * If not configured, returns null (the app will fallback to filesystem).
 */
async function getCollection() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || "";
  const dbName = process.env.MONGODB_DB || process.env.MONGO_DB || "lordkarma";
  const colName = process.env.MONGODB_COLLECTION || "sessions";

  if (!uri) return null;
  if (_col) return _col;

  _client = _client || new MongoClient(uri, { maxPoolSize: 5 });
  await _client.connect();
  const db = _client.db(dbName);
  _col = db.collection(colName);

  // helpful index
  try {
    await _col.createIndex({ session_id: 1 }, { unique: true });
    await _col.createIndex({ expires_at: 1 });
  } catch (_) {}

  return _col;
}

module.exports = { getCollection };
