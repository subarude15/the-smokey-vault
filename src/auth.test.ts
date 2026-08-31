import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdminToken, isAdmin, pinAccepted, requireAdmin } from "./auth.js";
import { setPin, verifyPin } from "./db.js";

const secret = "test-session-secret";

test("createAdminToken + isAdmin round-trip", () => {
  const token = createAdminToken(secret);
  assert.equal(isAdmin(`Bearer ${token}`, secret), true);
  assert.equal(isAdmin(token, secret), true);
  assert.equal(isAdmin(`Bearer ${token}`, "other-secret"), false);
  assert.equal(isAdmin(undefined, secret), false);
  assert.equal(isAdmin("Bearer forged", secret), false);
});

test("requireAdmin rejects missing sessions without leaking secrets", () => {
  let status = 200;
  let body: unknown;
  const reply = {
    code(n: number) {
      status = n;
      return {
        send(v: unknown) {
          body = v;
          return v;
        }
      };
    }
  };
  const result = requireAdmin({ headers: {} }, reply, secret);
  assert.equal(status, 401);
  assert.deepEqual(body, { error: "Admin session required" });
  assert.ok(result);
  assert.equal(JSON.stringify(body).includes(secret), false);
});

test("pinAccepted honors stored PIN and env recovery codes", () => {
  setPin("1357");
  assert.equal(verifyPin("1357"), true);
  assert.equal(pinAccepted("1357"), true);
  assert.equal(pinAccepted("0000"), false);

  const prevAdmin = process.env.ADMIN_PIN;
  const prevMaster = process.env.MASTER_PIN;
  try {
    process.env.ADMIN_PIN = "2468";
    process.env.MASTER_PIN = "3690";
    assert.equal(pinAccepted("2468"), true);
    assert.equal(pinAccepted("3690"), true);
  } finally {
    if (prevAdmin === undefined) delete process.env.ADMIN_PIN;
    else process.env.ADMIN_PIN = prevAdmin;
    if (prevMaster === undefined) delete process.env.MASTER_PIN;
    else process.env.MASTER_PIN = prevMaster;
    setPin(process.env.DEFAULT_PIN ?? "1234");
  }
});
