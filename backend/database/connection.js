import mongoose from "mongoose";
import * as logging from "../services/logging.js";
import * as readiness from "../services/readiness.js";
import { MONGO_URI, MONGO_HOST, MONGO_PORT, MONGO_DB } from "../utilities/constants.js";

// Single-instance app: one backend process owns one bundled local mongod, loopback only,
// nothing else ever connects (host/port/db are fixed — see lib/constants.js). The backend
// calls connect() once at boot; Mongoose then owns the connection and the schema indexes.
// A single module-level promise (the backend is one plain Node process) guarantees one
// connection and one "connected" log line; it clears on failure so the next call retries.
let connectPromise = null;
const trackedConnections = new WeakSet();

// Register only when the monitor actually connects (or when an isolated test supplies a fake
// connection). Merely importing the database barrel in runner-only mode must not initialize or
// mutate monitor readiness.
export function trackConnectionReadiness(connection = mongoose.connection) {
    if (trackedConnections.has(connection)) {
        return;
    }
    trackedConnections.add(connection);

    const markReady = () => readiness.setSubsystem("database", true);
    connection.on("connected", markReady);
    connection.on("reconnected", markReady);
    connection.on("disconnected", () => readiness.setSubsystem("database", false, "disconnected"));
    connection.on("close", () => readiness.setSubsystem("database", false, "closed"));
    connection.on("error", () => {
        // An error event does not necessarily make a still-connected Mongoose connection
        // unusable. Only withdraw readiness when its own state confirms it is no longer open.
        if (connection.readyState !== 1) {
            readiness.setSubsystem("database", false, "failed");
        }
    });

    if (connection.readyState === 1) {
        markReady();
    } else {
        readiness.setSubsystem("database", false, "disconnected");
    }
}

export async function connect() {
    trackConnectionReadiness();
    if (mongoose.connection.readyState === 1) {
        readiness.setSubsystem("database", true);
        return;
    }
    if (!connectPromise) {
        readiness.setSubsystem("database", false, "connecting");
        connectPromise = mongoose
            .connect(MONGO_URI)
            .then((m) => {
                readiness.setSubsystem("database", true);
                logging.log("db", `connected to MongoDB ${MONGO_HOST}:${MONGO_PORT} (db: ${MONGO_DB})`);
                return m;
            })
            .catch((error) => {
                connectPromise = null;
                readiness.setSubsystem("database", false, "failed");
                throw error;
            });
    }
    await connectPromise;
}

export async function close() {
    readiness.setSubsystem("database", false, "closing");
    try {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
    } catch (error) {
        connectPromise = null;
        if (mongoose.connection.readyState === 1) {
            readiness.setSubsystem("database", true);
        } else {
            readiness.setSubsystem("database", false, "failed");
        }
        throw error;
    }
    connectPromise = null;
    readiness.setSubsystem("database", false, "closed");
}
