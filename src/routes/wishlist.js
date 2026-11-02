import { ObjectId } from "mongodb";
import { Router } from "express";
import { col } from "../db.js";
import { requireUser } from "../auth.js";
import { notFound, badRequest } from "../errors.js";
import { assert } from "../validate.js";

const router = Router();

/* ---------------------------------------------------------------------------
 * GET /api/wishlist — the current member's saved studios (dashboard stat +
 * heart button pre-fill). Returns studio docs (with _id = studio id) plus
 * addedAt per row.
 * ------------------------------------------------------------------------- */
router.get("/", requireUser, async (req, res) => {
  const rows = await col("wishlist")
    .aggregate([
      { $match: { userId: new ObjectId(req.user.id) } },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: "studio",
          localField: "studioId",
          foreignField: "_id",
          as: "studio",
        },
      },
      // Rows whose studio was deleted drop out here.
      { $unwind: "$studio" },
      {
        $replaceRoot: {
          newRoot: { $mergeObjects: ["$studio", { addedAt: "$createdAt" }] },
        },
      },
    ])
    .toArray();

  res.json({ studios: rows });
});

/* ---------------------------------------------------------------------------
 * POST /api/wishlist { studioId } — toggle (all heart buttons).
 * ------------------------------------------------------------------------- */
router.post("/", requireUser, async (req, res) => {
  const id = String(req.body?.studioId ?? "");
  assert(
    /^[0-9a-f]{24}$/i.test(id),
    "studioId must be a valid studio id."
  );
  const studioId = new ObjectId(id);

  const exists = await col("studio").countDocuments({ _id: studioId });
  if (exists === 0) throw notFound("Studio not found.");

  const userId = new ObjectId(req.user.id);
  const existing = await col("wishlist").findOne({ userId, studioId });
  if (existing) {
    await col("wishlist").deleteOne({ _id: existing._id });
    res.json({ wishlisted: false });
    return;
  }

  await col("wishlist").insertOne({
    userId,
    studioId,
    createdAt: new Date(),
  });
  res.status(201).json({ wishlisted: true });
});

/* ---------------------------------------------------------------------------
 * DELETE /api/wishlist/:studioId — explicit remove.
 * ------------------------------------------------------------------------- */
router.delete("/:studioId", requireUser, async (req, res) => {
  const id = String(req.params.studioId);
  assert(/^[0-9a-f]{24}$/i.test(id), "studioId must be a valid studio id.");

  const result = await col("wishlist").deleteOne({
    userId: new ObjectId(req.user.id),
    studioId: new ObjectId(id),
  });
  if (result.deletedCount === 0) throw notFound("Not in your wishlist.");

  res.json({ removed: true });
});

export default router;
