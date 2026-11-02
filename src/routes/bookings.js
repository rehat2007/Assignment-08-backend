import { ObjectId } from "mongodb";
import { Router } from "express";
import { col } from "../db.js";
import { requireUser } from "../auth.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { assert, toDate, toInt } from "../validate.js";

const router = Router();

const LIFECYCLE = ["pending", "confirmed", "completed", "cancelled"];

/** The same invoice the front end used to generate client-side. */
function renderReceipt(booking, studio) {
  return [
    "StudioSpace — booking receipt",
    "================================",
    `Studio: ${studio.name} (${studio.location})`,
    `Date: ${booking.date}`,
    `Time: ${booking.startHour}:00 - ${booking.endHour}:00 (${booking.hours} hrs)`,
    "",
    `Studio time: ${booking.hours} × $${booking.price} = $${booking.studioTotal}`,
    `Security deposit: $${booking.deposit} (refunded after checkout)`,
    `Total: $${booking.total}`,
    "",
    `Booked by: ${booking.userName ?? "member"}`,
    "Thank you for booking with StudioSpace.",
  ].join("\n");
}

/* ---------------------------------------------------------------------------
 * POST /api/bookings — create a booking. The server re-checks overlap and
 * is the single source of truth for the total (hours × price + deposit).
 * Body: { studioId | studioSlug, date, startHour, endHour }
 * ------------------------------------------------------------------------- */
router.post("/", requireUser, async (req, res) => {
  const body = req.body ?? {};

  const key = body.studioId ?? body.studioSlug;
  assert(key !== undefined && key !== "", "studioId or studioSlug is required.");

  if (!/^[0-9a-f]{24}$/i.test(String(key))) {
    if (body.studioId !== undefined) {
      throw badRequest("studioId must be a valid id.");
    }
  }

  const studio = await col("studio").findOne(
    /^[0-9a-f]{24}$/i.test(String(key))
      ? { _id: new ObjectId(key) }
      : { slug: String(key).toLowerCase() }
  );
  if (!studio) throw notFound("Studio not found.");

  const date = toDate(body.date);
  const startHour = toInt(body.startHour, { min: 0, max: 23, name: "startHour" });
  const endHour = toInt(body.endHour, { min: 1, max: 24, name: "endHour" });
  assert(endHour > startHour, "endHour must be after startHour.");

  const hours = endHour - startHour;
  assert(
    hours >= studio.minHours,
    `This studio's minimum booking is ${studio.minHours} ${studio.minHours === 1 ? "hour" : "hours"}.`
  );

  // Overlap re-check against pending/confirmed/completed hours.
  const overlapCount = await col("booking").countDocuments({
    studioId: studio._id,
    date,
    status: { $in: ["pending", "confirmed", "completed"] },
    startHour: { $lt: endHour },
    endHour: { $gt: startHour },
  });
  if (overlapCount > 0) {
    throw conflict("That time slot is no longer available — pick another slot.");
  }

  const studioTotal = hours * studio.price;
  const now = new Date();

  const booking = {
    studioId: studio._id,
    userId: new ObjectId(req.user.id),
    userName: req.user.name,
    userEmail: req.user.email,
    hostUserId: studio.hostUserId,
    date,
    startHour,
    endHour,
    hours,
    status: "pending",
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
    createdAt: now,
    updatedAt: now,
  };

  const result = await col("booking").insertOne(booking);
  res.status(201).json({ booking: { ...booking, _id: result.insertedId } });
});

/* ---------------------------------------------------------------------------
 * GET /api/bookings — current user's bookings (?role=host for incoming
 * bookings on their studios). Optional ?status= filter.
 * ------------------------------------------------------------------------- */
router.get("/", requireUser, async (req, res) => {
  const userId = new ObjectId(req.user.id);
  const match = req.query.role === "host" ? { hostUserId: userId } : { userId };

  if (req.query.status !== undefined) {
    assert(
      LIFECYCLE.includes(req.query.status),
      `status filter must be one of: ${LIFECYCLE.join(", ")}.`
    );
    match.status = req.query.status;
  }

  const bookings = await col("booking")
    .find(match)
    .sort({ date: -1, startHour: -1, createdAt: -1 })
    .toArray();

  res.json({ bookings, count: bookings.length });
});

/* ---------------------------------------------------------------------------
 * PATCH /api/bookings/:id — status transitions:
 *   creator → cancel (pending/confirmed)
 *   host    → confirm (pending) / decline or cancel (pending/confirmed) / complete (confirmed)
 * ------------------------------------------------------------------------- */
router.patch("/:id", requireUser, async (req, res) => {
  const booking = await col("booking").findOne({
    _id: ObjectId.isValid(String(req.params.id)) ? new ObjectId(req.params.id) : null,
  });
  if (!booking) throw notFound("Booking not found.");

  const status = typeof req.body?.status === "string" ? req.body.status.toLowerCase() : "";
  if (!["cancelled", "declined", "confirmed", "completed"].includes(status)) {
    throw badRequest(
      "status must be one of: confirmed, declined, cancelled, completed."
    );
  }

  const isCreator = String(booking.userId) === req.user.id;
  const isHost = String(booking.hostUserId) === req.user.id;
  if (!isCreator && !isHost) throw forbidden("This booking belongs to another member.");

  if (status === "cancelled" || status === "declined") {
    assert(isCreator || isHost, "Only the booking's creator or the host can cancel it.");
    assert(
      booking.status === "pending" || booking.status === "confirmed",
      `A ${booking.status} booking can no longer be cancelled.`
    );
  } else {
    // confirm / complete are host-only decisions.
    assert(isHost, "Only the studio's host can confirm or complete bookings.");
    assert(
      status === "confirmed" ? booking.status === "pending" : booking.status === "confirmed",
      status === "confirmed"
        ? "Only pending bookings can be confirmed."
        : "Only confirmed bookings can be marked completed."
    );
  }

  const finalStatus = status === "declined" ? "cancelled" : status;
  const updated = await col("booking").findOneAndUpdate(
    { _id: booking._id },
    { $set: { status: finalStatus, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  res.json({ booking: updated });
});

/* ---------------------------------------------------------------------------
 * GET /api/bookings/:id/receipt — the "Invoice" button download. Pricing is
 * snapshotted at booking time, so later rate changes don't rewrite receipts.
 * ------------------------------------------------------------------------- */
router.get("/:id/receipt", requireUser, async (req, res) => {
  const booking = await col("booking").findOne({
    _id: ObjectId.isValid(String(req.params.id)) ? new ObjectId(req.params.id) : null,
  });
  if (!booking) throw notFound("Booking not found.");

  const isCreator = String(booking.userId) === req.user.id;
  const isHost = String(booking.hostUserId) === req.user.id;
  if (!isCreator && !isHost) throw forbidden("This booking belongs to another member.");

  const slug = booking.studioSnapshot?.slug ?? "studio";
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="receipt-${slug}-${booking.date}.txt"`
  );
  res.type("text/plain; charset=utf-8").send(
    renderReceipt(booking, {
      name: booking.studioSnapshot?.name ?? booking.studioId.toString(),
      location: booking.studioSnapshot?.location ?? "",
    })
  );
});

export default router;
