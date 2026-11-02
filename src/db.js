import { MongoClient } from "mongodb";
import dns from "node:dns";
dns.setServers(["1.1.1.1", "1.0.0.1"]);

// Same database the Next.js Better Auth instance uses, so `user` / `session`
// collections are shared and the API can validate the session cookie issued
// by the front end. The API owns: studio, booking, review, wishlist,
// newsletterSubscriber.
let client;
let db;

export async function connect() {
  if (db) return db;

  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing from studiospace_back_end/.env");
  }

  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db(process.env.DB_NAME || "studiospace");
  await ensureIndexes(db);
  return db;
}

export function getDb() {
  if (!db) throw new Error("Database not connected — call connect() first.");
  return db;
}

export function col(name) {
  return getDb().collection(name);
}

async function ensureIndexes(db) {
  await db.collection("studio").createIndex({ slug: 1 }, { unique: true });
  await db.collection("review").createIndex(
    { studioId: 1, userId: 1 },
    // Seed reviews have no userId — uniqueness only applies to real members.
    { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } }
  );
  await db
    .collection("wishlist")
    .createIndex({ userId: 1, studioId: 1 }, { unique: true });
  await db.collection("newsletterSubscriber").createIndex(
    { email: 1 },
    { unique: true, collation: { locale: "en", strength: 2 } }
  );
}
