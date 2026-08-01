// The one response envelope used on both sides of the wire: every controller returns it,
// every route sends it, and the frontend client normalizes failures into the same shape
// (see frontend/src/api/client.js). Callers check `.success` once and never branch on
// "was it a network error or an API error". `output` is a human-readable message; `data`
// is the payload (null on failure).
export function getResult(success, output, data = null) {
    return { success, output, data };
}
