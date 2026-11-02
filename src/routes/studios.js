import { ObjectId } from "mongodb";
import { Router } from "express";
import { col } from "../db.js";
import { requireUser } from "../auth.js";
import {
  conflict,
  forbidden,
  notFound,
  badRequest,
} from "../errors.js";
import {
  assert,
  CATEGORIES,
  CATEGORY_GRADIENTS,
  initials,
  imageUrlOrNull,
  slugify,
  toInt,
  toOptionalInt,
} from "../validate.js";

const router = Router();

/** Accepts either the studio _id or its slug (URLs use slugs, dashboards ids). */
function studioQuery(idOrSlug) {
  if (/^[0-9a-f]{24}$/i.test(String(idOrSlug))) {
    return { _id: new ObjectId(idOrSlug) };
  }
  return { slug: String(idOrSlug).toLowerCase() };
}

export async function findStudio(idOrSlug) {
  return col("studio").findOne(studioQuery(idOrSlug));
}

/* ---------------------------------------------------------------------------
 * GET /api/studios — explore page listing with filters, sort and paging.
 * q, category, location, minPrice, maxPrice, amenities, sort, page, limit
 * ------------------------------------------------------------------------- */
router.get("/", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filters = [];

  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filters.push({ $or: [{ name: rx }, { description: rx }, { location: rx }] });
  }

  if (req.query.category && req.query.category !== "all") {
    if (!CATEGORIES.includes(req.query.category)) {
      throw badRequest(
        `category must be one of: ${CATEGORIES.join(", ")}, all.`
      );
    }
    filters.push({ category: req.query.category });
  }

  if (typeof req.query.location === "string" && req.query.location.trim()) {
    filters.push({
      location: new RegExp(
        req.query.location.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      ),
    });
  }

  const minPrice = toOptionalInt(req.query.minPrice, { min: 0, max: 100000, name: "minPrice" });
  const maxPrice = toOptionalInt(req.query.maxPrice, { min: 0, max: 100000, name: "maxPrice" });
  if (minPrice !== undefined) filters.push({ price: { $gte: minPrice } });
  if (maxPrice !== undefined) filters.push({ price: { $lte: maxPrice } });

  if (typeof req.query.amenities === "string" && req.query.amenities.trim()) {
    const amenities = req.query.amenities
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    if (amenities.length) filters.push({ amenities: { $all: amenities } });
  }

  const match = filters.length ? { $and: filters } : {};

  const SORTS = {
    rating_desc: { rating: -1, reviewsCount: -1 },
    price_asc: { price: 1 },
    price_desc: { price: -1 },
    reviews_desc: { reviewsCount: -1 },
    newest: { createdAt: -1, _id: -1 },
  };
  const sort = SORTS[req.query.sort] ?? SORTS.rating_desc;
  if (req.query.sort !== undefined && !SORTS[req.query.sort]) {
    throw badRequest(`sort must be one of: ${Object.keys(SORTS).join(", ")}.`);
  }

  const limit = toOptionalInt(req.query.limit, { min: 1, max: 60, name: "limit" }) ?? 12;
  const page = toOptionalInt(req.query.page, { min: 1, max: 10000, name: "page" }) ?? 1;

  const [studios, total] = await Promise.all([
    col("studio")
      .find(match)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    col("studio").countDocuments(match),
  ]);

  res.json({
    studios,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

/* ---------------------------------------------------------------------------
 * POST /api/studios — create a listing (host only; /register-host form).
 * ------------------------------------------------------------------------- */
router.post("/", requireUser, async (req, res) => {
  const body = req.body ?? {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const category = typeof body.category === "string" ? body.category : "";

  assert(name.length >= 3 && name.length <= 120, "Name must be 3–120 characters.");
  assert(CATEGORIES.includes(category), `category must be one of: ${CATEGORIES.join(", ")}.`);

  const location = typeof body.location === "string" ? body.location.trim() : "";
  assert(location.length >= 3 && location.length <= 160, "Location must be 3–160 characters.");

  const price = toInt(body.price ?? 0, { min: 1, max: 10000, name: "price" });
  const deposit = toInt(body.deposit ?? 0, { min: 0, max: 100000, name: "deposit" });
  const capacity = toInt(body.capacity ?? 10, { min: 1, max: 500, name: "capacity" });
  const minHours = toInt(body.minHours ?? 1, { min: 1, max: 24, name: "minHours" });

  if (body.description !== undefined) {
    assert(
      typeof body.description === "string" && body.description.length <= 1200,
      "Description must be at most 1200 characters."
    );
  }
  if (body.amenities !== undefined) {
    assert(
      Array.isArray(body.amenities) &&
        body.amenities.every((a) => typeof a === "string" && a.length <= 60),
      "amenities must be an array of strings."
    );
  }

  // Unique slug from the name (…-2, …-3 on collisions).
  let slug = slugify(name) || "studio";
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? slug : `${slug}-${suffix + 1}`;
    if (!(await col("studio").findOne({ slug: candidate }, { projection: { _id: 1 } }))) {
      slug = candidate;
      break;
    }
  }

  const now = new Date();
  const studio = {
    slug,
    name,
    category,
    location,
    price,
    deposit,
    capacity,
    minHours,
    description:
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : "A new StudioSpace listing — description coming soon.",
    amenities: body.amenities ?? [],
    gradient: CATEGORY_GRADIENTS[category],
    image: imageUrlOrNull(body.image),
    rating: 5,
    reviewsCount: 0,
    hostUserId: new ObjectId(req.user.id),
    host: {
      name: req.user.name,
      initials: initials(req.user.name),
      tagline: "New host · responds within 24 hours",
      email: req.user.email,
    },
    createdAt: now,
    updatedAt: now,
  };

  const result = await col("studio").insertOne(studio);
  res.status(201).json({ studio: { ...studio, _id: result.insertedId } });
});

/* ---------------------------------------------------------------------------
 * GET /api/studios/:idOrSlug — detail page data (reviews summary + latest
 * reviews + host, everything the detail page renders in one call).
 * ------------------------------------------------------------------------- */
router.get("/:idOrSlug", async (req, res) => {
  const studio = await findStudio(req.params.idOrSlug);
  if (!studio) throw notFound("Studio not found.");

  const [reviewsSummary, reviews] = await Promise.all([
    col("review")
      .aggregate([
        { $match: { studioId: studio._id } },
        {
          $group: {
            _id: null,
            average: { $avg: "$rating" },
            count: { $sum: 1 },
            breakdown: {
              $push: "$rating",
            },
          },
        },
      ])
      .toArray(),
    col("review")
      .find({ studioId: studio._id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(6)
      .toArray(),
  ]);

  const summary = reviewsSummary[0] ?? null;
  res.json({
    studio,
    reviews,
    reviewsSummary: summary
      ? {
          average: Math.round(summary.average * 10) / 10,
          count: summary.count,
          distribution: [5, 4, 3, 2, 1].map(
            (stars) => summary.breakdown.filter((r) => r === stars).length
          ),
        }
      : null,
  });
});

/* ---------------------------------------------------------------------------
 * GET /api/studios/:idOrSlug/availability?date=YYYY-MM-DD — booked slots for
 * the booking modal's conflict checks (cancelled bookings free the day).
 * ------------------------------------------------------------------------- */
router.get("/:idOrSlug/availability", async (req, res) => {
  const studio = await findStudio(req.params.idOrSlug);
  if (!studio) throw notFound("Studio not found.");

  const date = typeof req.query.date === "string" ? req.query.date : "";
  assert(/^\d{4}-\d{2}-\d{2}$/.test(date), "date query param must be YYYY-MM-DD.");
  assert(!Number.isNaN(Date.parse(date)), "date is not a real calendar day.");

  const bookings = await col("booking")
    .find({
      studioId: studio._id,
      date,
      status: { $in: ["pending", "confirmed", "completed"] },
    })
    .sort({ startHour: 1 })
    .toArray();

  res.json({
    studioId: String(studio._id),
    date,
    minHours: studio.minHours,
    bookedSlots: bookings.map((booking) => ({
      bookingId: String(booking._id),
      startHour: booking.startHour,
      endHour: booking.endHour,
      hours: booking.hours,
      status: booking.status,
    })),
  });
});

/* ---------------------------------------------------------------------------
 * Reviews
 * ------------------------------------------------------------------------- */
router.get("/:idOrSlug/reviews", async (req, res) => {
  const studio = await findStudio(req.params.idOrSlug);
  if (!studio) throw notFound("Studio not found.");

  const reviews = await col("review")
    .find({ studioId: studio._id })
    .sort({ createdAt: -1, _id: -1 })
    .limit(50)
    .toArray();

  res.json({ reviews, count: reviews.length });
});

router.post("/:idOrSlug/reviews", requireUser, async (req, res) => {
  const studio = await findStudio(req.params.idOrSlug);
  if (!studio) throw notFound("Studio not found.");

  const userId = new ObjectId(req.user.id);

  // Only members who actually completed a session here may review.
  const completed = await col("booking").countDocuments({
    studioId: studio._id,
    userId,
    status: "completed",
  });
  if (completed === 0) {
    throw forbidden("Only members with a completed booking here can leave a review.");
  }

  const rating = toInt(req.body?.rating, { min: 1, max: 5, name: "rating" });
  const comment =
    typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
  assert(comment.length >= 4 && comment.length <= 800, "Comment must be 4–800 characters.");

  if (await col("review").findOne({ studioId: studio._id, userId })) {
    throw conflict("You already reviewed this studio.");
  }

  const review = {
    studioId: studio._id,
    userId,
    name: req.user.name,
    rating,
    comment,
    createdAt: new Date(),
  };
  await col("review").insertOne(review);

  // Nudge the studio's public rating/reviewsCount, keeping seeded totals sane.
  const updated = await col("studio").findOneAndUpdate(
    { _id: studio._id },
    {
      $inc: { reviewsCount: 1 },
      $set: {
        rating:
          Math.round(
            ((studio.rating * studio.reviewsCount + rating) / (studio.reviewsCount + 1)) *
              10
          ) / 10,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  res.status(201).json({ review, studio: updated });
});

/* ---------------------------------------------------------------------------
 * PATCH /api/studios/:idOrSlug — edit a listing (host/owner only).
 * Accepts any subset of: name, category, location, description, amenities,
 * price, deposit, capacity, minHours, image, gradient.
 * ------------------------------------------------------------------------- */
const PATCHABLE = [
  "name",
  "category",
  "location",
  "description",
  "amenities",
  "price",
  "deposit",
  "capacity",
  "minHours",
  "image",
  "gradient",
];

router.patch("/:idOrSlug", requireUser, async (req, res) => {
  const studio = await findStudio(req.params.idOrSlug);
  if (!studio) throw notFound("Studio not found.");
  assert(
    String(studio.hostUserId) === req.user.id,
    "Only the studio's host can update it.",
    403
  );

  const body = req.body ?? {};
  const unknown = Object.keys(body).filter((k) => !PATCHABLE.includes(k));
  if (unknown.length) {
    throw badRequest(`Unknown field(s): ${unknown.join(", ")}.`);
  }

  const updates = {};
  if (body.name !== undefined) {
    assert(
      typeof body.name === "string" && body.name.trim().length >= 3,
      "Name must be at least 3 characters."
    );
    updates.name = body.name.trim();
  }
  if (body.category !== undefined) {
    assert(CATEGORIES.includes(body.category), `category must be one of: ${CATEGORIES.join(", ")}.`);
    updates.category = body.category;
  }
  if (body.location !== undefined) {
    assert(
      typeof body.location === "string" && body.location.trim().length >= 3,
      "Location must be at least 3 characters."
    );
    updates.location = body.location.trim();
  }
  if (body.description !== undefined) {
    assert(
      typeof body.description === "string" && body.description.length <= 1200,
      "Description must be at most 1200 characters."
    );
    updates.description = body.description.trim();
  }
  if (body.amenities !== undefined) {
    assert(
      Array.isArray(body.amenities) &&
        body.amenities.every((a) => typeof a === "string" && a.length <= 60),
      "amenities must be an array of strings."
    );
    updates.amenities = body.amenities;
  }
  if (body.price !== undefined) updates.price = toInt(body.price, { min: 1, max: 10000, name: "price" });
  if (body.deposit !== undefined) updates.deposit = toInt(body.deposit, { min: 0, max: 100000, name: "deposit" });
  if (body.capacity !== undefined) updates.capacity = toInt(body.capacity, { min: 1, max: 500, name: "capacity" });
  if (body.minHours !== undefined) updates.minHours = toInt(body.minHours, { min: 1, max: 24, name: "minHours" });
  if (body.image !== undefined) updates.image = imageUrlOrNull(body.image);
  if (body.gradient !== undefined) {
    assert(typeof body.gradient === "string", "gradient must be a string class list.");
    updates.gradient = body.gradient;
  }

  assert(Object.keys(updates).length > 0, "Nothing to update — send at least one field.");

  const updated = await col("studio").findOneAndUpdate(
    { _id: studio._id },
    { $set: { ...updates, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  res.json({ studio: updated });
});

/* ---------------------------------------------------------------------------
 * DELETE /api/studios/:idOrSlug — remove a listing (owner only). Its reviews
 * go with it, and its pending booking requests are cancelled.
 * ------------------------------------------------------------------------- */
router.delete("/:idOrSlug", requireUser, async (req, res) => {
  const studio = await findStudio(req.params.idOrSlug);
  if (!studio) throw notFound("Studio not found.");
  assert(
    String(studio.hostUserId) === req.user.id,
    "Only the studio's host can delete it.",
    403
  );

  await Promise.all([
    col("studio").deleteOne({ _id: studio._id }),
    col("review").deleteMany({ studioId: studio._id }),
    col("booking").updateMany(
      { studioId: studio._id, status: "pending" },
      { $set: { status: "cancelled", updatedAt: new Date() } }
    ),
  ]);

  res.json({ deleted: true, studio: { _id: String(studio._id), slug: studio.slug } });
});

export default router;
