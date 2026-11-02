import { ObjectId } from "mongodb";
import { Router } from "express";
import { col } from "../db.js";
import { requireUser } from "../auth.js";

const router = Router();

/* ---------------------------------------------------------------------------
 * GET /api/host/listings — the host's own listings (dashboard "Update"/"Delete").
 * ------------------------------------------------------------------------- */
router.get("/listings", requireUser, async (req, res) => {
  const studios = await col("studio")
    .find({ hostUserId: new ObjectId(req.user.id) })
    .sort({ createdAt: -1 })
    .toArray();

  res.json({ studios, count: studios.length });
});

/* ---------------------------------------------------------------------------
 * GET /api/host/stats — dashboard stat cards: how many listings the host has
 * published and where their incoming bookings stand (plus wishlist savings).
 * ------------------------------------------------------------------------- */
router.get("/stats", requireUser, async (req, res) => {
  const userId = new ObjectId(req.user.id);

  const [listings, bookings, saved] = await Promise.all([
    col("studio").countDocuments({ hostUserId: userId }),
    col("booking")
      .aggregate([
        { $match: { hostUserId: userId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ])
      .toArray(),
    col("wishlist").countDocuments({ userId }),
  ]);

  const byStatus = Object.fromEntries(bookings.map((b) => [b._id, b.count]));
  const pending = byStatus.pending ?? 0;
  const confirmed = byStatus.confirmed ?? 0;
  const completed = byStatus.completed ?? 0;
  const cancelled = byStatus.cancelled ?? 0;

  res.json({
    listings,
    savedStudios: saved,
    bookings: {
      total: pending + confirmed + completed + cancelled,
      pending,
      confirmed,
      completed,
      cancelled,
    },
  });
});

export default router;
