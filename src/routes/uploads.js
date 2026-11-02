import { Router } from "express";
import { requireUser } from "../auth.js";
import { badRequest } from "../errors.js";
import { assert } from "../validate.js";

const router = Router();

/* ---------------------------------------------------------------------------
 * POST /api/uploads — server-side proxy to imgbb so the API key never ships
 * to the client (register-host gallery + profile photos).
 *
 * Body: { image } where image is a data URI ("data:image/png;base64,…") or
 * raw base64; adding { name } sets the file title on imgbb.
 *
 * Needs IMGBB_API_KEY in studiospace_back_end/.env (free key from imgbb.com).
 * ------------------------------------------------------------------------- */
const MAX_BASE64_LENGTH = 36_000_000; // imgbb's practical 32MB payload ceiling

router.post("/", requireUser, async (req, res) => {
  const apiKey = process.env.IMGBB_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: "Image host is not configured. Add IMGBB_API_KEY to studiospace_back_end/.env.",
    });
    return;
  }

  const image = typeof req.body?.image === "string" ? req.body.image : "";
  assert(image.length > 0, "image (data URI or base64) is required.");
  assert(
    image.length <= MAX_BASE64_LENGTH,
    "Image is over imgbb's 32MB limit."
  );

  // Accept `data:image/png;base64,<payload>` or the bare payload.
  const stripped = image.replace(/^data:image\/[a-z+.-]+;base64,(?=[A-Za-z0-9+/=])/, "");
  assert(
    /^[A-Za-z0-9+/]+={0,2}$/.test(stripped),
    "image must be a base64 string or a data URI."
  );

  const payload = new URLSearchParams({ key: apiKey, image: stripped });
  if (typeof req.body?.name === "string" && req.body.name.trim()) {
    payload.set("name", req.body.name.trim().slice(0, 200));
  }

  const response = await fetch("https://api.imgbb.com/1/upload", {
    method: "POST",
    body: payload,
  });
  const json = await response.json().catch(() => null);

  if (!response.ok || !json?.success) {
    res.status(502).json({
      error:
        json?.error?.message ??
        "Image host rejected the upload. Try a smaller JPEG/PNG.",
    });
    return;
  }

  res.status(201).json({
    url: json.data.display_url ?? json.data.url,
    thumbUrl: json.data.thumb?.url ?? null,
    deleteUrl: json.data.delete_url ?? null,
  });
});

export default router;
