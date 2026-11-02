// Demo data seed: creates usable Better Auth accounts (host + customers) plus
// listings, bookings in every state, reviews, wishlist rows and a newsletter
// subscriber. Safe to re-run — every demo document has a deterministic id or
// demo key, so it upserts instead of duplicating.
//
//   npm run seed:demo        (runs the catalog seed first)
//
// Demo logins (all use the same password):
//   host@studiospace.dev      / Studio123   → owns 4 listings, has incoming bookings
//   customer@studiospace.dev  / Studio123   → pending, confirmed + completed bookings
//   maya@studiospace.dev      / Studio123   → completed booking ready to review
//
import "dotenv/config";
import { createHash, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { ObjectId } from "mongodb";
import { connect, col, getDb } from "./db.js";
import { seedCatalog } from "./seed.js";
import { initials } from "./validate.js";

const DEMO_PASSWORD = "Studio123";

const ACCOUNTS = {
  host: { name: "Nadia Karim", email: "host@studiospace.dev" },
  customer: { name: "Rafi Chowdhury", email: "customer@studiospace.dev" },
  maya: { name: "Maya Hasan", email: "maya@studiospace.dev" },
};

// Demo host owns these four (the catalog seed leaves them unlinked).
const HOST_STUDIO_SLUGS = [
  "reverb-room-recording-suite",
  "blackbox-sound-stage",
  "north-sound-stage",
  "blue-note-suite",
];

const scryptAsync = promisify(scrypt);

/** Same format/hash Better Auth uses: `<16-byte hex salt>:<64-byte scrypt key>`. */
async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scryptAsync(password.normalize("NFKC"), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  });
  return `${salt}:${key.toString("hex")}`;
}

/** Stable ObjectId per demo key so re-runs update the same documents. */
function demoId(key) {
  return new ObjectId(
    createHash("md5")
      .update(`studiospace-demo:${key}`)
      .digest("hex")
      .slice(0, 24)
  );
}

/** Calendar day `offset` days from today (UTC-safe for demo dates). */
function isoDay(offset) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function upsertDemoUser({ name, email }) {
  const now = new Date();
  const password = await hashPassword(DEMO_PASSWORD);

  await col("user").updateOne(
    { email },
    {
      $set: { name, email, emailVerified: true, updatedAt: now },
      $setOnInsert: {
        _id: demoId(`user:${email}`),
        image: null,
        createdAt: now,
      },
    },
    { upsert: true }
  );

  const user = await col("user").findOne({ email });
  await col("account").updateOne(
    { providerId: "credential", userId: user._id },
    {
      $set: {
        accountId: String(user._id),
        providerId: "credential",
        userId: user._id,
        password,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: demoId(`account:${email}`),
        createdAt: now,
      },
    },
    { upsert: true }
  );

  return user;
}

async function assignHostStudio(studio, host) {
  const hostDoc = {
    name: host.name,
    initials: initials(host.name),
    tagline: "Demo host · responds within 1 hour",
    email: host.email,
  };

  await col("studio").updateOne(
    { _id: studio._id },
    { $set: { hostUserId: host._id, host: hostDoc, updatedAt: new Date() } }
  );

  return { ...studio, hostUserId: host._id, host: hostDoc };
}

function buildBooking({
  key,
  studio,
  customer,
  date,
  startHour,
  endHour,
  status,
  createdDaysAgo,
}) {
  const hours = endHour - startHour;
  const studioTotal = hours * studio.price;
  const createdAt = new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000);

  return {
    _id: demoId(`booking:${key}`),
    demo: true,
    demoKey: key,
    studioId: studio._id,
    userId: customer._id,
    userName: customer.name,
    userEmail: customer.email,
    hostUserId: studio.hostUserId,
    date,
    startHour,
    endHour,
    hours,
    status,
    price: studio.price,
    deposit: studio.deposit,
    studioTotal,
    total: studioTotal + studio.deposit,
    studioSnapshot: {
      name: studio.name,
      slug: studio.slug,
      category: studio.category,
      location: studio.location,
      gradient: studio.gradient,
      image: studio.image ?? null,
    },
    createdAt,
    updatedAt: new Date(),
  };
}

async function upsertReview({ studio, user, rating, comment }) {
  const existing = await col("review").findOne({
    studioId: studio._id,
    userId: user._id,
  });

  if (existing) {
    await col("review").updateOne(
      { _id: existing._id },
      { $set: { name: user.name, rating, comment, demo: true } }
    );
  } else {
    await col("review").insertOne({
      studioId: studio._id,
      userId: user._id,
      name: user.name,
      rating,
      comment,
      demo: true,
      createdAt: new Date(),
    });
  }

  // seedCatalog() just reset rating/reviewsCount to the catalog values, so this
  // runs for new *and* existing demo reviews — re-running stays idempotent
  // instead of dropping the member review from the public average.
  const fresh = await col("studio").findOne(
    { _id: studio._id },
    { projection: { rating: 1, reviewsCount: 1 } }
  );
  const count = fresh.reviewsCount ?? 0;
  const nextCount = count + 1;
  const nextRating =
    Math.round((((fresh.rating ?? 0) * count + rating) / nextCount) * 10) / 10;

  await col("studio").updateOne(
    { _id: studio._id },
    { $set: { rating: nextRating, reviewsCount: nextCount, updatedAt: new Date() } }
  );

  return !existing;
}

async function main() {
  await connect();

  // 1. Catalog first so the studio documents exist and are reset to the seed.
  const catalog = await seedCatalog();

  // 2. Demo accounts (user + credential account, hash identical to Better Auth).
  const host = await upsertDemoUser(ACCOUNTS.host);
  const customer = await upsertDemoUser(ACCOUNTS.customer);
  const maya = await upsertDemoUser(ACCOUNTS.maya);

  // 3. Give the demo host real listings.
  const owned = await col("studio")
    .find({ slug: { $in: HOST_STUDIO_SLUGS } })
    .toArray();
  if (owned.length !== HOST_STUDIO_SLUGS.length) {
    throw new Error(
      `Expected ${HOST_STUDIO_SLUGS.length} demo-host studios, found ${owned.length}. Run "npm run seed" first.`
    );
  }
  const studios = [];
  for (const studio of owned) {
    studios.push(await assignHostStudio(studio, host));
  }
  const bySlug = new Map(studios.map((studio) => [studio.slug, studio]));

  // 4. Bookings covering every lifecycle state for both dashboards.
  const bookings = [
    buildBooking({
      key: "rafi-reverb-pending",
      studio: bySlug.get("reverb-room-recording-suite"),
      customer,
      date: isoDay(10),
      startHour: 10,
      endHour: 13,
      status: "pending",
      createdDaysAgo: 2,
    }),
    buildBooking({
      key: "maya-blackbox-pending",
      studio: bySlug.get("blackbox-sound-stage"),
      customer: maya,
      date: isoDay(12),
      startHour: 9,
      endHour: 13,
      status: "pending",
      createdDaysAgo: 1,
    }),
    buildBooking({
      key: "rafi-north-confirmed",
      studio: bySlug.get("north-sound-stage"),
      customer,
      date: isoDay(16),
      startHour: 14,
      endHour: 18,
      status: "confirmed",
      createdDaysAgo: 5,
    }),
    buildBooking({
      key: "rafi-reverb-completed",
      studio: bySlug.get("reverb-room-recording-suite"),
      customer,
      date: isoDay(-20),
      startHour: 9,
      endHour: 12,
      status: "completed",
      createdDaysAgo: 30,
    }),
    buildBooking({
      key: "rafi-blackbox-completed",
      studio: bySlug.get("blackbox-sound-stage"),
      customer,
      date: isoDay(-40),
      startHour: 13,
      endHour: 17,
      status: "completed",
      createdDaysAgo: 55,
    }),
    buildBooking({
      key: "maya-blue-note-completed",
      studio: bySlug.get("blue-note-suite"),
      customer: maya,
      date: isoDay(-12),
      startHour: 13,
      endHour: 15,
      status: "completed",
      createdDaysAgo: 20,
    }),
    buildBooking({
      key: "maya-blue-note-cancelled",
      studio: bySlug.get("blue-note-suite"),
      customer: maya,
      date: isoDay(-5),
      startHour: 15,
      endHour: 17,
      status: "cancelled",
      createdDaysAgo: 8,
    }),
  ];

  for (const booking of bookings) {
    await col("booking").replaceOne({ _id: booking._id }, booking, {
      upsert: true,
    });
  }

  // 5. Reviews from members who actually completed a session.
  const newReviews = [];
  if (
    await upsertReview({
      studio: bySlug.get("reverb-room-recording-suite"),
      user: customer,
      rating: 5,
      comment:
        "Fantastic room — the live booth and console made tracking effortless. The host had everything patched before we arrived.",
    })
  ) {
    newReviews.push("Rafi → Reverb Room");
  }
  if (
    await upsertReview({
      studio: bySlug.get("blackbox-sound-stage"),
      user: customer,
      rating: 4,
      comment:
        "Great stage and lighting package. Parking was tight, but the space and crew delivered exactly what we needed.",
    })
  ) {
    newReviews.push("Rafi → Blackbox");
  }

  // 6. Wishlist rows (unique per user + studio; safe to re-run).
  const wishlist = [
    { user: customer, slug: "reverb-room-recording-suite" },
    { user: customer, slug: "cyc-wall-loft" },
    { user: customer, slug: "clay-makers-workshop" },
    { user: maya, slug: "blackbox-sound-stage" },
    { user: maya, slug: "north-sound-stage" },
  ];
  const allStudios = await col("studio").find({}).toArray();
  const studioBySlug = new Map(allStudios.map((studio) => [studio.slug, studio]));
  let wishlistCount = 0;
  for (const row of wishlist) {
    const studio = studioBySlug.get(row.slug);
    if (!studio) continue;
    await col("wishlist").updateOne(
      { userId: row.user._id, studioId: studio._id },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    wishlistCount += 1;
  }

  // 7. Newsletter subscriber.
  await col("newsletterSubscriber").updateOne(
    { email: ACCOUNTS.customer.email },
    { $setOnInsert: { subscribedAt: new Date() } },
    { upsert: true, collation: { locale: "en", strength: 2 } }
  );

  const [listingCount, bookingCount, reviewCount, savedCount] =
    await Promise.all([
      col("studio").countDocuments({ hostUserId: host._id }),
      col("booking").countDocuments({ demo: true }),
      col("review").countDocuments({ demo: true }),
      col("wishlist").countDocuments({
        userId: { $in: [customer._id, maya._id] },
      }),
    ]);

  console.log(
    `Catalog: ${catalog.created} created, ${catalog.updated} updated.`
  );
  console.log(
    `Demo host: ${host.email} (${listingCount} listings)\n` +
      `Demo customer: ${customer.email} (bookings + wishlist)\n` +
      `Demo reviewer: ${maya.email} (completed booking ready to review)`
  );
  console.log(
    `Demo data → ${bookingCount} bookings, ${reviewCount} member reviews, ${savedCount} wishlist rows.` +
      (newReviews.length ? ` New reviews: ${newReviews.join(", ")}.` : "")
  );
  console.log(`Login password for every demo account: ${DEMO_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error("Demo seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const db = getDb();
      await db.client.close();
    } catch {
      // connect() failed — nothing to close.
    }
  });
