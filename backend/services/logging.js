// Single chokepoint for process logging — every other service/controller logs through
// here instead of calling console.* directly, so the `[tag] message` format stays
// consistent and log output can be redirected/extended in one place later.
function format(tag, message) {
    return `[${tag}] ${message}`;
}

export function log(tag, message) {
    console.log(format(tag, message));
}

export function warn(tag, message) {
    console.warn(format(tag, message));
}

export function error(tag, message, err) {
    if (err !== undefined) {
        console.error(format(tag, message), err);
    } else {
        console.error(format(tag, message));
    }
}
