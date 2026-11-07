/**
 * A saved household location for the privacy byte scans, chosen so that the
 * search for it can only match a real leak.
 *
 * The scans used to seed `34.05, -118.24` and search the raw response for
 * "34.05". A response carries ISO timestamps, so a run whose clock read
 * `...T02:02:34.056Z` failed with no leak at all (CI, 2026-11-04). A seconds
 * field runs 00 to 59 and is the only place in a timestamp a "dd.dd" can sit,
 * so a coordinate whose whole-number part is 60 or more cannot occur inside
 * one, rounded or not. The extra digits make the full-precision value
 * distinctive, and the rounded forms still catch a leak that rounds it.
 */
export const HOUSEHOLD_LATITUDE = 61.2183947;
export const HOUSEHOLD_LONGITUDE = -149.9036218;

/** Every form of the location a response must never carry. */
export const LOCATION_SENTINELS: readonly string[] = [
  String(HOUSEHOLD_LATITUDE),
  String(HOUSEHOLD_LONGITUDE),
  HOUSEHOLD_LATITUDE.toFixed(2),
  HOUSEHOLD_LONGITUDE.toFixed(2),
  HOUSEHOLD_LATITUDE.toFixed(1),
  HOUSEHOLD_LONGITUDE.toFixed(1),
];

/**
 * True when `sentinel` could appear inside an ISO-8601 timestamp, which is the
 * false failure this module exists to prevent. Each test asserts it is false
 * for every sentinel, so a later edit to the coordinates cannot bring it back.
 */
export function couldOccurInTimestamp(sentinel: string): boolean {
  const match = /^-?(\d+)\.\d+$/.exec(sentinel);
  return match !== null && Number(match[1]) < 60;
}
