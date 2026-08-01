// JSON-over-WebSocket helpers, shared by both ends of the runner protocol — the runner in
// services/runner.js and the monitor's pool in services/runnerpool.js. `sendJson` is a safe send
// that silently drops the message when the socket isn't open; `readMessage` parses an incoming
// frame and returns null on malformed JSON so callers can ignore it without their own try/catch.
import { WebSocket } from "ws";

export function sendJson(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

export function readMessage(data) {
    try {
        return JSON.parse(data.toString());
    } catch {
        return null;
    }
}
