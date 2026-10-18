import test from "node:test";
import assert from "node:assert/strict";
import { greeting } from "./greeting.js";

test("greets by name", () => {
  assert.equal(greeting("Sam"), "Hello, Sam!");
});

test("greets without a name", () => {
  assert.equal(greeting(""), "Hello!");
  assert.equal(greeting(undefined), "Hello!");
});
