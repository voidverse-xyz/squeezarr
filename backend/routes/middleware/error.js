import { getResult } from "shared/response.js";

export function handleError(err, _req, res, _next) {
    const result = getResult(false, err.message);

    res.status(500).send(result);
}
