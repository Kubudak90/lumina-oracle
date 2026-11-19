// Seeded randomized property tests (reproducible: fixed seeds). Each compares the contracts with
// an independent BigInt reference model.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { DEFAULT_STIPEND, etchReadCore, setMarket, deploy, now, mineAt, setNextTimestamp, rng, Status } = require("./helpers");

const CASES = 500;
const E8 = 10n ** 8n;
const UINT64_MAX = 2n ** 64n - 1n;

describe("Lighter: property tests (seeded, ≥500 cases each)", function () {
  this.timeout(600_000);

  // ------------------------------------------------------------------ source scaling

  async function sourceFixture() {
    const core = await etchReadCore();
    await setMarket(core, 0, { indexPrice: 1n });
    const wide = [];
    const narrow = [];
    for (let d = 0; d <= 18; d += 1) {
      wide.push(await deploy("LighterCorePriceSource", 0, d, 1n, 2n ** 200n, DEFAULT_STIPEND, "wide"));
      narrow.push(await deploy("LighterCorePriceSource", 0, d, E8, 10n ** 12n, DEFAULT_STIPEND, "narrow"));
    }
    return { core, wide, narrow };
  }

  function scaleModel(raw, decimals) {
    return decimals <= 8 ? raw * 10n ** BigInt(8 - decimals) : raw / 10n ** BigInt(decimals - 8);
  }

  async function expectSource(source, raw, decimals, min, max, label) {
    const scaled = scaleModel(raw, decimals);
    if (raw === 0n) {
      await expect(source.latestAnswer(), label).to.be.revertedWithCustomError(source, "ZeroPrice");
    } else if (scaled < min || scaled > max) {
      await expect(source.latestAnswer(), label).to.be.revertedWithCustomError(source, "PriceOutOfBounds");
    } else {
      expect(await source.latestAnswer(), label).to.equal(scaled);
    }
  }

  it("LighterCorePriceSource scaling and bounds match the model", async function () {
    const { core, wide, narrow } = await loadFixture(sourceFixture);
    const r = rng(0x5ca1e);
    for (let i = 0; i < CASES; i += 1) {
      const decimals = r.int(0, 18);
      let raw;
      const kind = r.int(0, 9);
      if (kind === 0) raw = 0n;
      else if (kind === 1) raw = UINT64_MAX;
      else if (kind === 2) raw = 10n ** BigInt(r.int(0, 19)); // powers of ten around scale edges
      else raw = r.magnitude(64);
      if (raw > UINT64_MAX) raw = UINT64_MAX;
      await core.setPrices(0, raw, r.magnitude(64));
      const label = `case ${i}: raw ${raw}, decimals ${decimals}`;
      await expectSource(wide[decimals], raw, decimals, 1n, 2n ** 200n, label);
      await expectSource(narrow[decimals], raw, decimals, E8, 10n ** 12n, label);
    }
  });

  // -------------------------------------------------------------------- guard logic

  async function guardFixture() {
    const [, guardian, keeper, provider] = await ethers.getSigners();
    const source = await deploy("MockLighterPriceSource", 0, 3000n * E8);
    const guard = await deploy("LuminaPriceGuard", provider.address, guardian.address, keeper.address, 180, 300, 600);
    await guard.connect(guardian).addMarket(0, source.target);
    return { guardian, keeper, source, guard };
  }

  function guardModel(c) {
    if (c.paused) return Status.PAUSED;
    if (c.refAge > c.maxRefAge) return Status.REFERENCE_STALE;
    if (c.coreAge > c.maxCorePriceAge) return Status.CORE_PRICE_STALE;
    if (c.liveRevert) return Status.CORE_READ_FAILED;
    const diff = c.live > c.ref ? c.live - c.ref : c.ref - c.live;
    if (diff > c.ref || diff * 10_000n > BigInt(c.maxDeviationBps) * c.ref) return Status.DEVIATION;
    return Status.OK;
  }

  it("LuminaPriceGuard.borrowStatus matches the model (ages, deviation, liveness, pause, read failure)", async function () {
    const { guardian, keeper, source, guard } = await loadFixture(guardFixture);
    const r = rng(0x9a2d);
    const near = (bound, spread) => Math.max(0, bound + r.int(-spread, spread)); // values around a boundary
    // 40 % at the boundary (±2), 40 % clearly inside, 20 % anywhere up to `ceiling`
    const age = (bound, ceiling) => {
      const roll = r.int(0, 9);
      if (roll < 4) return near(bound, 2);
      if (roll < 8) return r.int(10, bound);
      return r.int(10, ceiling);
    };
    const seen = new Map();
    for (let i = 0; i < CASES; i += 1) {
      const snapshot = await network.provider.send("evm_snapshot", []);
      const maxRefAge = r.int(30, 3600);
      const maxDeviationBps = r.int(10, 2000);
      const maxCorePriceAge = r.int(180, 30 * 86400);
      const ref = r.chance(0.15) ? r.big(2n ** 64n, 2n ** 128n - 1n) : r.big(E8, 100_000n * E8);
      const devBps = r.chance(0.5) ? near(maxDeviationBps, 3) : r.int(0, 15_000);
      let live = r.chance(0.5) ? ref + (ref * BigInt(devBps)) / 10_000n : ref - (ref * BigInt(Math.min(devBps, 9_999))) / 10_000n;
      if (live <= 0n) live = 1n;
      if (r.chance(0.03)) live = 2n ** 255n - 1n; // int256.max: must be DEVIATION, never an overflow
      const c = {
        maxRefAge,
        maxDeviationBps,
        maxCorePriceAge,
        ref,
        live,
        // ≥ 10 s so the transactions after the reference post still land before T
        refAge: Math.max(10, age(maxRefAge, 7200)),
        coreAge: Math.max(12, age(maxCorePriceAge, 40 * 86400)),
        paused: r.chance(0.1),
        liveRevert: r.chance(0.08),
      };

      // Timeline: setters at S; an observation (poke, unchanged price) at P = T − coreAge; Core
      // moves and a poke at P + 2 records the change, dated at P; reference posted at Q with
      // observedAt = T − refAge; live price moved after Q without a poke; evaluate at T.
      const start = (await now()) + 10n;
      const T = start + 50n * 86400n;
      const P = T - BigInt(c.coreAge);
      const observedAt = T - BigInt(c.refAge);
      const Q = observedAt > P + 3n ? observedAt : P + 3n;
      // every transaction gets an explicit timestamp (no wall-clock dependence)
      await setNextTimestamp(start);
      await guard.connect(guardian).setMaxRefAge(c.maxRefAge);
      await setNextTimestamp(start + 1n);
      await guard.connect(guardian).setMaxDeviationBps(c.maxDeviationBps);
      await setNextTimestamp(start + 2n);
      await guard.connect(guardian).setMaxCorePriceAge(c.maxCorePriceAge);
      const stored = (await guard.getMarket(0))[4];
      const corePriceAfterP = stored === E8 ? 2n * E8 : E8; // differs from stored
      await setNextTimestamp(P);
      await guard.poke(0); // observation at P, unchanged
      await setNextTimestamp(P + 1n);
      await source.setAnswer(corePriceAfterP);
      await setNextTimestamp(P + 2n);
      await guard.poke(0); // change seen at P + 2, dated at P
      expect((await guard.getMarket(0))[5]).to.equal(P);
      await setNextTimestamp(Q);
      await guard.connect(keeper).postReference(0, c.ref, observedAt); // also pokes: price unchanged
      await setNextTimestamp(Q + 1n);
      await source.setAnswer(c.live); // live Core moves; not poked → liveness stays at P
      await setNextTimestamp(Q + 2n);
      await source.setShouldRevert(c.liveRevert);
      await setNextTimestamp(Q + 3n);
      await guard.connect(guardian).setBorrowsPaused(c.paused);
      await mineAt(T);

      const expected = guardModel(c);
      const [status] = await guard.borrowStatus();
      expect(status, `case ${i}: ${JSON.stringify(c, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`).to.equal(expected);
      expect(await guard.isBorrowAllowed()).to.equal(expected === Status.OK);
      expect(await guard.isLiquidationAllowed()).to.equal(true);
      seen.set(expected, (seen.get(expected) ?? 0) + 1);
      await network.provider.send("evm_revert", [snapshot]);
    }
    // every outcome the model can produce was exercised
    for (const status of [Status.OK, Status.PAUSED, Status.REFERENCE_STALE, Status.CORE_PRICE_STALE, Status.CORE_READ_FAILED, Status.DEVIATION]) {
      expect(seen.get(status) ?? 0, `status ${status} exercised`).to.be.greaterThan(5);
    }
  });

  // --------------------------------------------------------------- dual-oracle rate

  const DECIMALS = [0, 1, 6, 8, 12, 17, 18];

  async function dualFixture() {
    const [, , , provider] = await ethers.getSigners();
    const assetSource = await deploy("MockLighterPriceSource", 0, E8);
    const collateralSource = await deploy("MockLighterPriceSource", 0, E8);
    const guard = await deploy("MockBorrowGuard");
    const tokens = {};
    for (const d of DECIMALS) tokens[d] = await deploy("MockDecimalsToken", d);
    const oracles = {};
    for (const ad of DECIMALS) {
      for (const cd of DECIMALS) {
        oracles[`${ad}/${cd}`] = await deploy(
          "LighterDualOracle", tokens[ad].target, tokens[cd].target, assetSource.target, collateralSource.target,
          guard.target, `${ad}/${cd}`,
        );
      }
    }
    void provider;
    return { assetSource, collateralSource, guard, oracles };
  }

  function rateModel(assetPrice, collateralPrice, ad, cd) {
    return (10n ** 36n * assetPrice) / (collateralPrice * 10n ** BigInt(18 + ad - cd));
  }

  function fraxLendTwoStep(assetPrice, collateralPrice, ad, cd) {
    return (10n ** 36n * assetPrice) / collateralPrice / 10n ** BigInt(18 + 8 - 8 + ad - cd);
  }

  it("LighterDualOracle rate matches the model and the FraxLend two-step formula exactly", async function () {
    const { assetSource, collateralSource, guard, oracles } = await loadFixture(dualFixture);
    const r = rng(0xd0a1);
    let nonZero = 0;
    for (let i = 0; i < CASES; i += 1) {
      const ad = r.pick(DECIMALS);
      const cd = r.pick(DECIMALS);
      const pa = r.chance(0.2) ? r.big(E8 / 100n, 10n ** 14n) : r.magnitude(66); // up to ~7e19
      const pc = r.chance(0.2) ? r.big(E8 / 100n, 10n ** 14n) : r.magnitude(66);
      const bad = r.chance(0.3);
      await assetSource.setAnswer(pa);
      await collateralSource.setAnswer(pc);
      await guard.setAllowed(!bad);
      const oracle = oracles[`${ad}/${cd}`];
      const expected = rateModel(pa, pc, ad, cd);
      const label = `case ${i}: pa ${pa}, pc ${pc}, decimals ${ad}/${cd}`;
      expect(expected, label).to.equal(fraxLendTwoStep(pa, pc, ad, cd));
      if (expected === 0n) {
        await expect(oracle.getPrices(), label).to.be.revertedWithCustomError(oracle, "ZeroRate");
        continue;
      }
      nonZero += 1;
      expect(await oracle.getPrices(), label).to.deep.equal([bad, expected, expected]);
      const n = cd - ad;
      const normalized = n > 0 ? expected / 10n ** BigInt(n) : expected * 10n ** BigInt(-n);
      expect(await oracle.getPricesNormalized(), label).to.deep.equal([bad, normalized, normalized]);
    }
    expect(nonZero).to.be.greaterThan(CASES / 2);
  });
});
