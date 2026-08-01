// Files controller — business logic for the "files" resource, lifted out of the route handlers so
// the routes stay thin wiring. Split by responsibility: list.js is the read side (the
// paginated listing + bucket counts) and mutations.js is the write side (delete, replace,
// requeue, stop, output removal). Route handlers import this barrel under the `filesController`
// alias; every function returns the response envelope (getResult), never throws.
export { list } from "./list.js";
export { remove, deleteOutput, replace, requeue, stop } from "./mutations.js";
