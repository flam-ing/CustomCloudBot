import test from "node:test";
import assert from "node:assert/strict";
import { effortLabel, modelChipLabel, botChipLabel, formatDuration, toastDuration, sendsOnEnter, placePopover, EFFORTS } from "../public/composer-ui.mjs";

test("model chip names the model and adds the thinking depth only when chosen", () => {
  assert.equal(modelChipLabel("자동 선택 · 추천", ""), "자동 선택");
  assert.equal(modelChipLabel("GPT-OSS 120B · 선택됨", "high"), "GPT-OSS 120B · 높게");
  assert.equal(modelChipLabel("", "xhigh"), "자동 선택 · 최대");
  assert.equal(modelChipLabel("mock-chat-1", "unknown"), "mock-chat-1");
  assert.deepEqual(EFFORTS.map(([value]) => value), ["", "low", "medium", "high", "xhigh"]);
  assert.equal(effortLabel(undefined), "기본");
  assert.equal(effortLabel("medium"), "보통");
});

test("bot chip shows who will answer in plain words", () => {
  const bots = [{ id: "a", name: "분석" }, { id: "b", name: "설계" }, { id: "c", name: "검토" }];
  assert.equal(botChipLabel([], bots), "봇 없음");
  assert.equal(botChipLabel(["b"], bots), "설계");
  assert.equal(botChipLabel(["a", "c"], bots), "분석 외 1");
  assert.equal(botChipLabel(["gone", "c"], bots), "검토");
});

test("durations read as minutes and seconds, and toasts stay readable but brief", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(12_400), "0:12");
  assert.equal(formatDuration(120_000), "2:00");
  assert.equal(formatDuration(-5), "0:00");
  assert.ok(toastDuration("복사했습니다.") >= 2600);
  assert.ok(toastDuration("가".repeat(500)) <= 7000);
});

test("Enter sends on desktop but breaks the line on touch keyboards", () => {
  const key = (extra = {}) => ({ key: "Enter", ...extra });
  assert.equal(sendsOnEnter(key()), true);
  assert.equal(sendsOnEnter(key({ shiftKey: true })), false);
  assert.equal(sendsOnEnter(key({ isComposing: true })), false);
  assert.equal(sendsOnEnter(key({ keyCode: 229 })), false);
  assert.equal(sendsOnEnter({ key: "a" }), false);
  assert.equal(sendsOnEnter(key(), { touch: true }), false);
  assert.equal(sendsOnEnter(key({ metaKey: true }), { touch: true }), true);
  assert.equal(sendsOnEnter(key({ ctrlKey: true }), { touch: true }), true);
});

test("popovers open above the composer trigger and never cover the trigger row", () => {
  const viewport = { width: 1440, height: 900 };
  const trigger = { left: 900, right: 940, top: 840, bottom: 876 };
  const tall = placePopover(trigger, { width: 354, height: 1200 }, viewport, { align: "end" });
  assert.equal(tall.placement, "above");
  assert.equal(tall.left, 940 - 354);
  assert.ok(tall.top >= 12);
  assert.ok(tall.top + Math.min(1200, tall.maxHeight) <= trigger.top - 8);
  const short = placePopover(trigger, { width: 320, height: 200 }, viewport);
  assert.equal(short.top, 840 - 8 - 200);
  assert.equal(short.left, 900);
});

test("popovers stay inside a phone screen and flip below when there is no room above", () => {
  const phone = { width: 390, height: 844 };
  const right = placePopover({ left: 330, right: 374, top: 780, bottom: 824 }, { width: 320, height: 300 }, phone);
  assert.equal(right.left, 390 - 12 - 320);
  assert.equal(right.width, 320);
  const narrow = placePopover({ left: 10, right: 54, top: 700, bottom: 744 }, { width: 600, height: 100 }, phone);
  assert.equal(narrow.width, 390 - 24);
  assert.equal(narrow.left, 12);
  const nearTop = placePopover({ left: 10, right: 54, top: 20, bottom: 64 }, { width: 200, height: 300 }, phone);
  assert.equal(nearTop.placement, "below");
  assert.equal(nearTop.top, 72);
  const keyboard = placePopover({ left: 10, right: 54, top: 380, bottom: 424 }, { width: 200, height: 600 }, { top: 0, width: 390, height: 440 });
  assert.equal(keyboard.placement, "above");
  assert.ok(keyboard.maxHeight <= 380 - 8 - 12);
});

test("confirmation copy picks the right Korean particle for a room name", async () => {
  const { topicParticle } = await import("../public/composer-ui.mjs");
  assert.equal(topicParticle("디자인 회의방"), "은");
  assert.equal(topicParticle("개인 비서 "), "는");
  assert.equal(topicParticle("Plan B"), "은(는)");
});
