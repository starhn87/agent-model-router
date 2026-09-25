import assert from "node:assert/strict";
import { test } from "node:test";
// The plugin must stay dependency-free, so it carries copies of the router's policy.
// These checks fail when one copy changes without the other. Run after `npm run build`.
import { isSimpleTurn as routerSimpleTurn, SENSITIVE_PATTERN as routerSensitive } from "../../dist/policy.js";
import { EFFORT_CRITERIA, TIER_CRITERIA } from "../../dist/jev.js";
import { isSimpleTurn, jevRequest, SENSITIVE_PATTERN } from "../hooks/register.js";

test("the plugin screens sensitive prompts with the router's pattern", () => {
  assert.equal(SENSITIVE_PATTERN.source, routerSensitive.source);
  assert.equal(SENSITIVE_PATTERN.flags, routerSensitive.flags);
});

test("the plugin sends Jev the router's tier and effort criteria", () => {
  const { questions } = jevRequest("example");
  assert.deepEqual(questions.tier.criteria, TIER_CRITERIA);
  assert.deepEqual(questions.effort.criteria, EFFORT_CRITERIA);
});

test("the plugin's local simple-turn rule matches the router's", () => {
  const prompts = ["안녕", "안녕하세요!", "hello", "hi there", '"좋내요" 맞춤법 고쳐줘', "i has apple 맞춤법 고쳐줘",
    "Fix the spelling: i has an apple", "fix grammar: this is wrong", "그 문장 맞춤법 고쳐줘", "Refactor the router",
    "Fix the spelling: \"goodd morning\"", `${"a ".repeat(130)}맞춤법 고쳐줘`, "line one\nline two 맞춤법 고쳐줘"];
  for (const prompt of prompts) assert.equal(isSimpleTurn(prompt), routerSimpleTurn(prompt), prompt);
});
