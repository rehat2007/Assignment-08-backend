import { badRequest } from "./errors.js";

export const CATEGORIES = ["photo", "film", "podcast", "music", "workshop"];

// Representative gradient per category, mirroring the front-end art system.
export const CATEGORY_GRADIENTS = {
  photo: "bg-linear-to-br from-[#f49a72] via-[#ef7d84] to-[#8f5cf1]",
  film: "bg-linear-to-br from-[#f6a35c] via-[#e4743e] to-[#401f2e]",
  podcast: "bg-linear-to-br from-[#77d8b4] via-[#53b98c] to-[#2d6a74]",
  music: "bg-linear-to-br from-[#c9b8fb] via-[#8b7cf7] to-[#4f3fd6]",
  workshop: "bg-linear-to-br from-[#f5c98a] via-[#e79a6f] to-[#9c4f6e]",
};

export function assert(condition, message, status = 400) {
  if (!condition) {
    throw badRequest(message);
  }
}

export function toInt(value, { min = -Infinity, max = Infinity, name = "value" } = {}) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw badRequest(`${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

export function toOptionalInt(value, opts) {
  if (value === undefined || value === null || value === "") return undefined;
  return toInt(value, opts);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/;

/** "YYYY-MM-DD" for a calendar day (no timezone surprises — date-only strings). */
export function toDate(value, name = "date") {
  assert(typeof value === "string" && DATE_RE.test(value), `${name} must be in YYYY-MM-DD format.`);
  assert(!Number.isNaN(Date.parse(value)), `${name} is not a real calendar day.`);
  return value;
}

export function toEmail(value) {
  assert(typeof value === "string" && EMAIL_RE.test(value), "A valid email is required.");
  return value.trim().toLowerCase();
}

export function imageUrlOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  assert(
    typeof value === "string" && HTTP_URL_RE.test(value) && value.length <= 2000,
    "Image must be an http(s) URL."
  );
  return value;
}

export function initials(name) {
  return (
    String(name ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "H"
  );
}

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 96);
}
