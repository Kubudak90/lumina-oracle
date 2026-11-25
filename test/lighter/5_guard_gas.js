const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { DEFAULT_STIPEND, etchReadCore, setMarket, deploy, now } = require("./helpers");

/**
 * Audit fixes v1, F2 (audit 2026-11-21 N-ORA-01): the dual oracle never reports "bad data" when
 * the caller withheld gas from the guard call. A guard answer other than "allowed" counts only if
 * the guard was given the full GUARD_CALL_GAS; with less, getPrices() reverts
 * InsufficientGasForGuard, so nobody can make a pair cache a forged bad flag for a block. A guard
 * that is really broken still yields bad data (never a revert) once the full stipend is forwarded.
 */

const E8 = 10n ** 8n;
const MOCK_READ_CORE_COSTLY = "contracts/lighter/test/LighterTestMocks.sol:MockReadCoreCostly";
const WORK = 300_000n; // gas a liquidation still needs after the rate update (stand-in)
const INSUFFICIENT_GAS = ethers.id("InsufficientGasForGuard()").slice(0, 10);
const Mode = { REVERT: 1, EMPTY_RETURN: 2, BAD_WORD: 3, BURN_GAS: 4, LONG_RETURN: 5, HUGE_RETURN: 6, MAX_RETURN: 7 };

async function withSnapshot(fn) {
  const id = await network.provider.send("evm_snapshot", []);
  try {
    return await fn();
  } finally {
    await network.provider.send("evm_revert", [id]);
  }
}

/** Revert data of a failed send, from the error hardhat throws. */
function revertData(error) {
  for (let e = error; e; e = e.error ?? e.cause) {
    if (typeof e.data === "string" && e.data.startsWith("0x")) return e.data;
    if (e.data && typeof e.data.data === "string") return e.data.data;
  }
  return null;
}

/**
 * Sends `method(...args)` on `contract` with `gasLimit` in a fresh block, inside a snapshot that
 * is reverted afterwards. Returns { ok, gasUsed, cache, data } (cache = the caller's stored
 * (lastTimestamp, oneOracleBad, rate) after a success; data = revert data after a failure).
 */
async function trySend(contract, method, args, gasLimit) {
  return withSnapshot(async () => {
    try {
      const tx = await contract[method](...args, { gasLimit });
      const rc = await tx.wait();
      return { ok: rc.status === 1, gasUsed: rc.gasUsed, cache: await contract.cache() };
    } catch (e) {
      return { ok: false, data: revertData(e), message: e.message };
    }
  });
}

/**
 * Real wiring as the deploy script builds it: LighterCorePriceSource (ETH, stipend 100k) and
 * FixedPriceSource (USDC), LuminaPriceGuard (180 s / 300 bps / 600 s) guarding market 0 with an
 * honest keeper reference, LighterDualOracle WETH/USDC, and a pair-like caller.
 * `costlyReadCore`: READ_CORE charges ~20k gas per read (Lighter docs) instead of a few thousand.
 */
async function build({ costlyReadCore }) {
  const [, guardian, keeper, provider] = await ethers.getSigners();
  if (costlyReadCore) {
    const core = await etchReadCore(MOCK_READ_CORE_COSTLY);
    await core.setIndexPrice(300_000n); // ETH 3000.00
  } else {
    const core = await etchReadCore();
    await setMarket(core, 0, { indexPrice: 300_000n });
  }
  const ethSource = await deploy("LighterCorePriceSource", 0, 2, 100n * E8, 100_000n * E8, DEFAULT_STIPEND, "ETH");
  const usdSource = await deploy("FixedPriceSource", E8, "USDC");
  const guard = await deploy("LuminaPriceGuard", provider.address, guardian.address, keeper.address, 180, 300, 600);
  await guard.connect(guardian).addMarket(0, ethSource.target);
  const usdc = await deploy("MockDecimalsToken", 6);
  const weth = await deploy("MockDecimalsToken", 18);
  const oracle = await deploy("LighterDualOracle", weth.target, usdc.target, ethSource.target, usdSource.target, guard.target, "WETH/USDC");
  const caller = await deploy("PairLikeOracleCaller", oracle.target);
  await guard.connect(keeper).postReference(0, 3000n * E8, await now());
  expect(await guard.isBorrowAllowed()).to.equal(true);
  // Like a live pair's exchangeRateInfo, the cache slot is non-zero before the calls under test, so
  // writing it costs ~5k gas, not ~22k (a zero slot would hide the window the scan looks for).
  await caller.updateExchangeRate();
  const insufficientGas = INSUFFICIENT_GAS;
  return { guardian, keeper, ethSource, usdSource, guard, usdc, weth, oracle, caller, insufficientGas };
}

/** Same oracle wiring over the settable MockBorrowGuard (failure modes). */
async function buildWithMockGuard() {
  const core = await etchReadCore();
  await setMarket(core, 0, { indexPrice: 300_000n });
  const ethSource = await deploy("LighterCorePriceSource", 0, 2, 100n * E8, 100_000n * E8, DEFAULT_STIPEND, "ETH");
  const usdSource = await deploy("FixedPriceSource", E8, "USDC");
  const usdc = await deploy("MockDecimalsToken", 6);
  const weth = await deploy("MockDecimalsToken", 18);
  const mockGuard = await deploy("MockBorrowGuard");
  const oracle = await deploy("LighterDualOracle", weth.target, usdc.target, ethSource.target, usdSource.target, mockGuard.target, "WETH/USDC");
  const caller = await deploy("PairLikeOracleCaller", oracle.target);
  const probe = await deploy("OracleGasProbe");
  const insufficientGas = INSUFFICIENT_GAS;
  return { mockGuard, oracle, caller, probe, insufficientGas };
}

describe("Lighter: LighterDualOracle guard gas (F2 / N-ORA-01)", function () {
  this.timeout(600_000);
  let snapshotId;
  beforeEach(async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });
  afterEach(async () => {
    await network.provider.send("evm_revert", [snapshotId]); // restores READ_CORE's code and the clock
  });

  for (const costlyReadCore of [false, true]) {
    const label = costlyReadCore ? "READ_CORE ~20k gas per read" : "MockReadCore";

    it(`no gas limit makes a pair-like updateExchangeRate() succeed and cache bad data while the guard allows borrows (${label})`, async function () {
      const { guard, caller, insufficientGas } = await build({ costlyReadCore });
      const honest = await trySend(caller, "updateExchangeRate", [], 3_000_000);
      expect(honest.ok).to.equal(true);
      expect(honest.cache.oneOracleBad).to.equal(false);

      // Fine steps from below the cost of the two source reads up past the honest gas use, then
      // coarse steps up to where the guard always gets its full stipend.
      const limits = [];
      for (let g = 25_000n; g <= honest.gasUsed + 40_000n; g += 250n) limits.push(g);
      for (let g = honest.gasUsed + 50_000n; g <= 1_200_000n; g += 25_000n) limits.push(g);

      const poisoned = [];
      let starved = 0;
      let succeeded = 0;
      for (const g of limits) {
        const r = await trySend(caller, "updateExchangeRate", [], g);
        if (r.ok) {
          succeeded += 1;
          if (r.cache.oneOracleBad) poisoned.push(g);
        } else if (r.data === insufficientGas) {
          starved += 1;
        }
      }
      console.log(`      [${label}] honest gasUsed ${honest.gasUsed}; ${limits.length} limits: ${succeeded} ok, ${poisoned.length} of them bad, ${starved} reverted InsufficientGasForGuard`);
      expect(poisoned, "gas limits that cached oneOracleBad = true").to.deep.equal([]);
      expect(starved, "the scan covered limits at which the guard was starved").to.be.greaterThan(0);
      expect(succeeded).to.be.greaterThan(0);
      expect(await guard.isBorrowAllowed()).to.equal(true);
    });
  }

  it("forwarded gas exactly GUARD_CALL_GAS: a broken guard yields bad data, one unit less reverts", async function () {
    const { mockGuard, oracle, probe, insufficientGas } = await buildWithMockGuard();
    const GUARD_CALL_GAS = await oracle.GUARD_CALL_GAS();
    const [, rate] = await oracle.getPrices();
    await mockGuard.setMode(Mode.BURN_GAS); // consumes everything it is given

    // smallest gas for getPrices() that does not revert
    let lo = 30_000n;
    let hi = 3_000_000n;
    expect((await probe.probe(oracle.target, lo))[0]).to.equal(false);
    expect((await probe.probe(oracle.target, hi))[0]).to.equal(true);
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if ((await probe.probe(oracle.target, mid))[0]) hi = mid;
      else lo = mid;
    }
    const decode = (ret) => oracle.interface.decodeFunctionResult("getPrices", ret);

    const [okAt, retAt, usedAt] = await probe.probe(oracle.target, hi);
    expect(okAt).to.equal(true);
    expect(decode(retAt)).to.deep.equal([true, rate, rate]);

    const [okBelow, retBelow] = await probe.probe(oracle.target, hi - 1n);
    expect(okBelow).to.equal(false);
    expect(retBelow).to.equal(insufficientGas);

    // At the boundary the guard really received GUARD_CALL_GAS (not less through the 63/64 rule):
    // it burns everything it gets, and the call costs the same as with ample gas.
    const [okAmple, retAmple, usedAmple] = await probe.probe(oracle.target, 5_000_000n);
    expect(okAmple).to.equal(true);
    expect(decode(retAmple)).to.deep.equal([true, rate, rate]);
    const diff = usedAmple > usedAt ? usedAmple - usedAt : usedAt - usedAmple;
    console.log(`      boundary: getPrices() gas ${hi}, consumed ${usedAt} vs ${usedAmple} with 5M (GUARD_CALL_GAS ${GUARD_CALL_GAS})`);
    expect(diff).to.be.lessThan(50n); // code-path differences only; a 63/64 cut would show here
    expect(usedAt).to.be.greaterThan(GUARD_CALL_GAS);
  });

  it("an honest 'not allowed' with full gas is bad data (no revert); with less gas it reverts", async function () {
    const { guardian, guard, oracle, caller, insufficientGas } = await build({ costlyReadCore: false });
    const [, rate] = await oracle.getPrices();
    await guard.connect(guardian).setBorrowsPaused(true);
    expect(await oracle.getPrices()).to.deep.equal([true, rate, rate]);
    expect(await oracle.getPricesNormalized()).to.deep.equal([true, rate * 10n ** 12n, rate * 10n ** 12n]);

    const estimate = await caller.updateExchangeRate.estimateGas();
    const full = await trySend(caller, "updateExchangeRate", [], estimate);
    expect(full.ok).to.equal(true);
    expect(full.cache.oneOracleBad).to.equal(true);

    const starved = await trySend(caller, "updateExchangeRate", [], 300_000n);
    expect(starved.ok).to.equal(false);
    expect(starved.data).to.equal(insufficientGas);
    await expect(oracle.getPrices({ gasLimit: 300_000 })).to.be.revertedWithCustomError(oracle, "InsufficientGasForGuard");
    await expect(oracle.getPricesNormalized({ gasLimit: 300_000 })).to.be.revertedWithCustomError(oracle, "InsufficientGasForGuard");
  });

  it("reverting, gas-burning and oversized-return guards with full gas: bad data, and a liquidation-like call succeeds", async function () {
    const { mockGuard, oracle, caller, insufficientGas } = await buildWithMockGuard();
    const [, rate] = await oracle.getPrices();
    const cases = [
      ["require(false)", () => mockGuard.setShouldRevert(true)],
      ...Object.entries(Mode).map(([name, mode]) => [name, () => mockGuard.setMode(mode)]),
    ];
    for (const [name, arm] of cases) {
      await withSnapshot(async () => {
        await arm();
        expect(await oracle.getPrices({ gasLimit: 3_000_000 }), name).to.deep.equal([true, rate, rate]);

        const estimate = await caller.liquidateLike.estimateGas(0n, WORK);
        const ok = await trySend(caller, "liquidateLike", [0n, WORK], estimate);
        expect(ok.ok, `${name}: liquidation-like call at its estimate`).to.equal(true);
        expect(ok.cache.oneOracleBad, name).to.equal(true);
        expect(ok.cache.rate, name).to.equal(rate);

        const starved = await trySend(caller, "liquidateLike", [0n, WORK], WORK + 200_000n);
        expect(starved.ok, `${name}: starved`).to.equal(false);
        expect(starved.data, `${name}: starved`).to.equal(insufficientGas);
      });
    }
  });

  for (const [costlyReadCore, before, after] of [
    [false, 0n, WORK],
    [true, 0n, WORK],
    [true, WORK, 0n], // worst case for the rule: all other work happens before the oracle call
  ]) {
    const label = `${costlyReadCore ? "READ_CORE ~20k gas per read" : "MockReadCore"}, ${before / 1000n}k gas before / ${after / 1000n}k after the rate update`;

    it(`estimate with a fresh cache, inclusion one block later with a stale reference: estimate + GUARD_CALL_GAS + 100,000 succeeds (${label})`, async function () {
      const { guard, keeper, oracle, caller, insufficientGas } = await build({ costlyReadCore });
      const GUARD_CALL_GAS = await oracle.GUARD_CALL_GAS();

      // Block B: someone refreshes the pair's cache; the liquidator estimates against that block.
      await network.provider.send("evm_setAutomine", [false]);
      let estimate;
      try {
        await caller.connect(keeper).updateExchangeRate({ gasLimit: 3_000_000 });
        estimate = await caller.liquidateLike.estimateGas(before, after); // eth_estimateGas on the pending block
        await network.provider.send("evm_mine", []);
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
      const blockB = await ethers.provider.getBlock("latest");
      expect((await caller.cache()).lastTimestamp).to.equal(BigInt(blockB.timestamp));
      expect(estimate, "the estimate skipped the oracle (fresh cache)").to.be.lessThan(WORK + 60_000n);

      // Block B+1: the keeper reference is now older than maxRefAge, so the guard says "not allowed".
      const [, , , refObservedAt] = await guard.getMarket(0);
      const maxRefAge = await guard.maxRefAge();

      // the old bot rule (estimate + 25%) now reverts instead of caching a forged bad flag ...
      await network.provider.send("evm_setNextBlockTimestamp", [Number(refObservedAt + maxRefAge + 1n)]);
      const old = await trySend(caller, "liquidateLike", [before, after], estimate + estimate / 4n);
      expect(old.ok).to.equal(false);
      expect(old.data).to.equal(insufficientGas);

      // ... and the shipped rule goes through with honest bad data
      const staleAt = Number(refObservedAt + maxRefAge + 1n);
      const sendAt = async (gasLimit) => {
        await network.provider.send("evm_setNextBlockTimestamp", [staleAt]);
        return trySend(caller, "liquidateLike", [before, after], gasLimit);
      };
      const shippedLimit = estimate + GUARD_CALL_GAS + 100_000n;
      const shipped = await sendAt(shippedLimit);
      expect(shipped.ok).to.equal(true);
      expect(shipped.cache.oneOracleBad).to.equal(true);
      expect(shipped.cache.lastTimestamp).to.equal(BigInt(staleAt));

      // margin of the shipped rule: the smallest limit that succeeds in the stale block
      let lo = estimate;
      let hi = shippedLimit;
      while (hi - lo > 100n) {
        const mid = (lo + hi) / 2n;
        if ((await sendAt(mid)).ok) hi = mid;
        else lo = mid;
      }
      console.log(`      [${label}] estimate ${estimate}; shipped limit ${shippedLimit} (gasUsed ${shipped.gasUsed}); minimum that succeeds ~${hi}, margin ~${shippedLimit - hi}`);
      expect(hi).to.be.lessThan(shippedLimit);
    });
  }
});
