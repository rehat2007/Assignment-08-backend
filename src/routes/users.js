import { ObjectId } from "mongodb";
import { Router } from "express";
import { col } from "../db.js";
import { requireUser } from "../auth.js";
import { badRequest } from "../errors.js";
import { assert, imageUrlOrNull } from "../validate.js";

const router = Router();

/* ---------------------------------------------------------------------------
 * PATCH /api/users/me — update profile (name, avatar image). Both fields
 * optional; send image: null (or "") to clear the photo and fall back to
 * initials in the navbar.
 * ------------------------------------------------------------------------- */
router.patch("/me", requireUser, async (req, res) => {
  const body = req.body ?? {};
  const updates = {};

  if (body.name !== undefined) {
    assert(
      typeof body.name === "string" && body.name.trim().length >= 2,
      "Name must be at least 2 characters."
    );
    updates.name = body.name.trim();
  }
  if (body.image !== undefined) {
    updates.image = imageUrlOrNull(body.image);
  }

  if (Object.keys(updates).length === 0) {
    throw badRequest("Send name and/or image to update.");
  }

  try {
    const updated = await col("user").findOneAndUpdate(
      { _id: ObjectId.createFromHexString(req.user.id) },
      { $set: updates },
      { returnDocument: "after" }
    );
    if (!updated) throw badRequest("Account not found.");

    res.json({
      user: {
        id: String(updated._id),
        name: updated.name,
        email: updated.email,
        image: updated.image ?? null,
      },
    });
  } catch (error) {
    if (error?.code === undefined && error?.status) throw error;
    throw badRequest("Could not update profile.");
  }
});

export default router;
