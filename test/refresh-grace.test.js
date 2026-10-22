// Runs in its own process so the grace window can be enabled.
process.env.REFRESH_REUSE_GRACE_SECONDS = "30";
const { setup } = await import("./helpers.js");
import assert from "node:assert/strict";
import { after, it } from "node:test";

const { api, pool, createUser } = await setup();
after(() => pool.end());

it("lets two tabs refresh with the same token at once, but never after logout", async () => {
  const user = await createUser();
  const tabA = await api().post("/v1/auth/refresh").send({ refreshToken: user.refreshToken }).expect(200);
  const tabB = await api().post("/v1/auth/refresh").send({ refreshToken: user.refreshToken }).expect(200);
  assert.notEqual(tabA.body.refreshToken, tabB.body.refreshToken);
  // Both tabs keep working
  await api().post("/v1/auth/refresh").send({ refreshToken: tabA.body.refreshToken }).expect(200);
  await api().post("/v1/auth/refresh").send({ refreshToken: tabB.body.refreshToken }).expect(200);

  const other = await createUser();
  await api().post("/v1/auth/logout").send({ refreshToken: other.refreshToken }).expect(204);
  await api().post("/v1/auth/refresh").send({ refreshToken: other.refreshToken }).expect(401);
});
