import assert from "node:assert/strict";
import test from "node:test";
import {
  canReuseRelayAccountBinding,
  RELAY_BINDING_MAX_AGE_MS,
  wechatImageCacheKey,
} from "../src/wechatImageCache.ts";

test("WeChat image cache is isolated by Relay, account, and source content hash", () => {
  const hash = "a".repeat(64);
  const key = wechatImageCacheKey("https://relay.example.com/", "wx-account-a", hash);
  assert.equal(key, wechatImageCacheKey("https://relay.example.com", "wx-account-a", hash.toUpperCase()));
  assert.notEqual(key, wechatImageCacheKey("https://relay.example.com", "wx-account-b", hash));
  assert.notEqual(key, wechatImageCacheKey("https://other.example.com", "wx-account-a", hash));
  assert.notEqual(key, wechatImageCacheKey("https://relay.example.com", "wx-account-a", "b".repeat(64)));
});

test("relay account binding is reusable only after current-session verification and before expiry", () => {
  const now = 1_800_000_000_000;
  const binding = { relayUrl: "https://relay.example.com/", verifiedAt: now - 1_000 };
  assert.equal(canReuseRelayAccountBinding(binding, "https://relay.example.com", false, now), false);
  assert.equal(canReuseRelayAccountBinding(binding, "https://relay.example.com", true, now), true);
  assert.equal(canReuseRelayAccountBinding(binding, "https://other.example.com", true, now), false);
  assert.equal(canReuseRelayAccountBinding(
    { ...binding, verifiedAt: now - RELAY_BINDING_MAX_AGE_MS - 1 },
    "https://relay.example.com",
    true,
    now,
  ), false);
  assert.equal(canReuseRelayAccountBinding({ ...binding, verifiedAt: now + 1 }, "https://relay.example.com", true, now), false);
});
