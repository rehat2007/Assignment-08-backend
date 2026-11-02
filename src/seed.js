// Seed script: loads the front-end catalog (src/lib/studios.js — the same data
// the site was cloned from) into the `studio` collection and inserts the
// catalog's reviews. Safe to re-run: studios are upserted by slug, seeded
// reviews only inserted when a studio has none.
//
//   npm run seed
//
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { connect, col, getDb } from "./db.js";
import { STUDIOS } from "../../studiospace_front_end/src/lib/studios.js";

/**
 * Upsert the catalog and its sample reviews. Assumes connect() already ran.
 * Returns the catalog stats so callers (seed-demo.js) can reuse this.
 */
export async function seedCatalog() {
  // Map catalog owner emails onto Better Auth accounts where they exist.
  const emails = [...new Set(STUDIOS.map((s) => s.host.ownerEmail))];
  const users = await col("user")
    .find({ email: { $in: emails } })
    .toArray();
  const userByEmail = new Map(users.map((user) => [user.email, user]));

  let created = 0;
  let updated = 0;

  for (const studio of STUDIOS) {
    const hostUser = userByEmail.get(studio.host.ownerEmail);
    const now = new Date();

    const doc = {
      slug: studio.slug,
      name: studio.name,
      category: studio.category,
      location: studio.location,
      rating: studio.rating,
      price: studio.price,
      gradient: studio.gradient,
      description: studio.description,
      deposit: studio.deposit,
      capacity: studio.capacity,
      minHours: studio.minHours,
      reviewsCount: studio.reviewsCount,
      amenities: studio.amenities,
      image: null,
      hostUserId: hostUser?._id ?? null,
      host: {
        name: studio.host.name,
        initials: studio.host.initials,
        tagline: studio.host.tagline,
        email: studio.host.ownerEmail,
      },
      updatedAt: now,
      seed: true,
    };

    const existing = await col("studio").findOne({ slug: studio.slug });

    if (existing) {
      await col("studio").updateOne(
        { _id: existing._id },
        { $set: doc, $setOnInsert: { createdAt: existing.createdAt ?? now } }
      );
      updated += 1;
    } else {
      await col("studio").insertOne({ ...doc, createdAt: now });
      created += 1;
    }

    const studioId = existing?._id ?? (
      await col("studio").findOne({ slug: studio.slug }, { projection: { _id: 1 } })
    )._id;

    // Seed the catalog's sample reviews once (they carry no userId).
    if ((await col("review").countDocuments({ studioId, userId: null })) === 0) {
      // New reviews from members count up first, oldest seeds go last.
      let seeds = studio.reviews.length;
      for (const review of [...studio.reviews].reverse()) {
        await col("review").insertOne({
          studioId,
          userId: null,
          name: review.name,
          rating: review.rating,
          comment: review.comment,
          createdAt:
            existing?.createdAt ??
            new Date(Date.now() - seeds * 12 * 60 * 60 * 1000),
          seedRank: seeds,
        });
        seeds -= 1;
      }
    }
  }

  return {
    created,
    updated,
    linked: users.length,
    emails,
    userByEmail,
  };
}

async function main() {
  await connect();
  const stats = await seedCatalog();

  console.log(
    `Seeded studio → ${stats.created} created, ${stats.updated} updated. Reviews ensured. Hosts linked: ${stats.linked}/${stats.emails.length} emails.`
  );
  console.log(
    stats.emails
      .map(
        (email) =>
          `${email}: ${
            stats.userByEmail.has(email)
              ? "linked"
              : "no user account (hostUserId: null)"
          }`
      )
      .join("\n")
  );
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main()
    .catch((error) => {
      console.error("Seed failed:", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      // Collected here so seed runs close the shared client from db.js.
      try {
        const db = getDb();
        await db.client.close();
      } catch {
        // connect() failed — nothing to close.
      }
    });
}
