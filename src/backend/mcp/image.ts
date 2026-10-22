// Swiggy image URLs for photo cards (Food dishes / restaurants, Instamart
// products, cart lines). Live payloads carry either a full CDN URL
// (`https://media-assets.swiggy.com/swiggy/image/upload/<path>`) or a bare
// image id / path (`restaurantCoverImageId: "RX_THUMBNAIL/…JPG"`,
// `"u7dynyeabdgn5rujasvl"`). Both become a sized CDN URL; nothing is invented —
// no id means no image.

const CDN_UPLOAD = "https://media-assets.swiggy.com/swiggy/image/upload/";

/** Card / thumbnail widths (px) served by the CDN's resize transform. */
export const IMG_CARD = 400;
export const IMG_THUMB = 160;

/**
 * Turn a Swiggy image URL or bare image id into a resized CDN URL. Non-Swiggy
 * http(s) URLs are returned as-is (spaces escaped). Returns "" when empty.
 */
export function swiggyImageUrl(value: unknown, width: number = IMG_CARD): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  let url: string;
  if (/^https?:\/\//i.test(raw)) {
    url = raw;
  } else {
    url = CDN_UPLOAD + raw.replace(/^\/+/, "");
  }
  // Some catalog paths contain literal spaces ("NPI-099468 _1_….png").
  url = url.replace(/ /g, "%20");
  const i = url.indexOf("/image/upload/");
  if (i < 0 || !/media-assets\.swiggy\.com|res\.cloudinary\.com/.test(url)) return url;
  const head = url.slice(0, i + "/image/upload/".length);
  const rest = url.slice(head.length);
  // Already transformed (fl_lossy,… / w_…) → leave it alone.
  if (/^[a-z]{1,3}_[^/]*\//.test(rest)) return url;
  return `${head}fl_lossy,f_auto,q_auto,w_${width}/${rest}`;
}
