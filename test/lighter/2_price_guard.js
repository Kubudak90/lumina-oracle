const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { DEFAULT_STIPEND, etchReadCore, setMarket, deploy, now, Status } = require("./helpers");

const E8 = 10n ** 8n;
const MAX_REF_AGE = 180n;
const MAX_DEVIATION_BPS = 300n;
const MAX_CORE_PRICE_AGE = 600n;

describe("Lighter: LuminaPriceGuard", function () {
  async function fixture() {
    const [deployer, guardian, keeper, other, provider] = await ethers.getSigners();
    const core = await etchReadCore();
    for (let id = 0; id <= 8; id += 1) {
      await setMarket(core, id, { indexPrice: 300_000n }); // 3000.00 at 2 decimals
    }
    const sources = [];
    for (let id = 0; id <= 8; id += 1) {
      sources.push(
        await deploy("LighterCorePriceSource", id, 2, 1n, 10n ** 30n, DEFAULT_STIPEND, `market ${id}`),
      );
    }
    const guard = await deploy(
      "LuminaPriceGuard", provider.address, guardian.address, keeper.address,
      MAX_REF_AGE, MAX_DEVIATION_BPS, MAX_CORE_PRICE_AGE,
    );
    return { deployer, guardian, keeper, other, provider, core, sources, guard };
  }

  /** Guard with ETH (market 0) guarded and a fresh matching reference. */
  async function guardedFixture() {
    const f = await fixture();
    await f.guard.connect(f.guardian).addMarket(0, await f.sources[0].getAddress());
    await f.guard.connect(f.keeper).postReference(0, 3000n * E8, await nextTimestamp());
    return f;
  }

  async function nextTimestamp() {
    return (await now()) + 1n;
  }

  async function expectStatus(guard, status, marketId = 0n) {
    const [actualStatus, actualMarket] = await guard.borrowStatus();
    expect(actualStatus, "status").to.equal(status);
    if (status !== Status.OK && status !== Status.PAUSED && status !== Status.NO_MARKETS) {
      expect(actualMarket, "market").to.equal(marketId);
    }
    expect(await guard.isBorrowAllowed()).to.equal(status === Status.OK);
    // R1-1: liquidations are never blocked by the guard, whatever its state.
    expect(await guard.isLiquidationAllowed()).to.equal(true);
  }

  describe("construction and sentinel interface", function () {
    it("stores the provider, roles and default parameters", async function () {
      const { guard, guardian, keeper, provider } = await loadFixture(fixture);
      expect(await guard.ADDRESSES_PROVIDER()).to.equal(provider.address);
      expect(await guard.guardian()).to.equal(guardian.address);
      expect(await guard.keeper()).to.equal(keeper.address);
      expect(await guard.maxRefAge()).to.equal(MAX_REF_AGE);
      expect(await guard.maxDeviationBps()).to.equal(MAX_DEVIATION_BPS);
      expect(await guard.maxCorePriceAge()).to.equal(MAX_CORE_PRICE_AGE);
    });

    it("rejects zero addresses and out-of-range parameters", async function () {
      const { guardian, keeper, provider } = await loadFixture(fixture);
      const factory = await ethers.getContractFactory("LuminaPriceGuard");
      const base = [provider.address, guardian.address, keeper.address, 180, 300, 600];
      await expect(factory.deploy(ethers.ZeroAddress, ...base.slice(1))).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy(base[0], ethers.ZeroAddress, ...base.slice(2))).to.be.revertedWithCustomError(factory, "ZeroAddress");
      for (const [index, value] of [[3, 29], [3, 3601], [4, 9], [4, 2001], [5, 179], [5, 30 * 86400 + 1]]) {
        const args = [...base];
        args[index] = value;
        await expect(factory.deploy(...args)).to.be.revertedWithCustomError(factory, "OutOfBounds");
      }
    });

    it("exposes the Aave sentinel interface without sequencer support", async function () {
      const { guard, guardian } = await loadFixture(fixture);
      expect(await guard.getSequencerOracle()).to.equal(ethers.ZeroAddress);
      expect(await guard.getGracePeriod()).to.equal(0n);
      await expect(guard.connect(guardian).setSequencerOracle(guardian.address)).to.be.revertedWithCustomError(guard, "Unsupported");
      await expect(guard.connect(guardian).setGracePeriod(1)).to.be.revertedWithCustomError(guard, "Unsupported");
    });
  });

  describe("borrow decision", function () {
    it("blocks borrows with no guarded market, and with a market but no reference", async function () {
      const { guard, guardian, sources } = await loadFixture(fixture);
      await expectStatus(guard, Status.NO_MARKETS);
      await guard.connect(guardian).addMarket(0, await sources[0].getAddress());
      await expectStatus(guard, Status.NO_REFERENCE, 0n);
    });

    it("allows borrows with a fresh matching reference", async function () {
      const { guard } = await loadFixture(guardedFixture);
      await expectStatus(guard, Status.OK);
    });

    it("blocks borrows once the reference is older than maxRefAge (boundary inclusive)", async function () {
      const { guard } = await loadFixture(guardedFixture);
      const [, , , observedAt] = await guard.getMarket(0);
      await time.setNextBlockTimestamp(observedAt + MAX_REF_AGE);
      await ethers.provider.send("evm_mine", []);
      await expectStatus(guard, Status.OK);
      await ethers.provider.send("evm_mine", []);
      await expectStatus(guard, Status.REFERENCE_STALE, 0n);
    });

    it("blocks borrows beyond maxDeviationBps in either direction (boundary inclusive)", async function () {
      const { guard, core } = await loadFixture(guardedFixture);
      await core.setPrices(0, 309_000n, 309_000n); // +3.00 %
      await expectStatus(guard, Status.OK);
      await core.setPrices(0, 309_001n, 309_001n); // +3.0003 %
      await expectStatus(guard, Status.DEVIATION, 0n);
      await core.setPrices(0, 291_000n, 291_000n); // -3.00 %
      await expectStatus(guard, Status.OK);
      await core.setPrices(0, 290_999n, 290_999n);
      await expectStatus(guard, Status.DEVIATION, 0n);
    });

    it("reports a failed Core read as CORE_READ_FAILED without reverting", async function () {
      const { guard, core } = await loadFixture(guardedFixture);
      await core.removeMarket(0);
      await expectStatus(guard, Status.CORE_READ_FAILED, 0n);
      await expect(guard.poke(0)).to.be.reverted;
    });

    it("treats a malformed or failing source answer as CORE_READ_FAILED, never reverting", async function () {
      const { guard, guardian, keeper } = await loadFixture(fixture);
      const source = await deploy("MockLighterPriceSource", 0, 3000n * E8);
      await guard.connect(guardian).addMarket(0, source.target);
      await guard.connect(keeper).postReference(0, 3000n * E8, await nextTimestamp());
      await expectStatus(guard, Status.OK);
      for (const mode of [1, 2, 3, 4, 5, 6]) { // revert, empty, bad word (-1), burn gas, 64-byte, 64-KiB return
        await source.setMode(mode);
        await expectStatus(guard, Status.CORE_READ_FAILED, 0n);
      }
      await source.setMode(0);
      for (const answer of [0n, -1n]) {
        await source.setAnswer(answer);
        await expectStatus(guard, Status.CORE_READ_FAILED, 0n);
      }
    });

    it("a malformed answer is rejected by poke too and never touches liveness state", async function () {
      const { guard, guardian, keeper, other } = await loadFixture(fixture);
      const source = await deploy("MockLighterPriceSource", 0, 3000n * E8);
      await guard.connect(guardian).addMarket(0, source.target);
      await guard.connect(keeper).postReference(0, 3000n * E8, await nextTimestamp());
      const before = await guard.getMarket(0);
      // 64-byte answer whose first word (1) differs from the stored price
      await source.setMode(5);
      await expect(guard.connect(other).poke(0)).to.be.revertedWithCustomError(guard, "CoreReadFailed").withArgs(0);
      await expect(guard.connect(keeper).postReference(0, 3000n * E8, await nextTimestamp()))
        .to.be.revertedWithCustomError(guard, "CoreReadFailed");
      expect(await guard.getMarket(0)).to.deep.equal(before);
      // back to a valid, unchanged price: no change is credited
      await source.setMode(0);
      await expect(guard.connect(other).poke(0)).to.not.emit(guard, "CorePriceChanged");
      expect((await guard.getMarket(0))[5]).to.equal(before[5]);
    });

    it("handles references above uint64 and an int256.max live price without overflow", async function () {
      const { guard, guardian, keeper } = await loadFixture(fixture);
      const wide = 2n ** 100n;
      const source = await deploy("MockLighterPriceSource", 0, wide);
      await guard.connect(guardian).addMarket(0, source.target);
      await guard.connect(keeper).postReference(0, wide, await nextTimestamp()); // matching, > uint64.max
      await expectStatus(guard, Status.OK);
      await guard.connect(keeper).postReference(0, 2n ** 128n - 1n, await nextTimestamp());
      await expectStatus(guard, Status.DEVIATION, 0n);
      await source.setAnswer(2n ** 255n - 1n); // int256.max: diff * BPS would overflow without the short-circuit
      await guard.connect(keeper).postReference(0, 2n ** 127n, await nextTimestamp()); // pokes int256.max
      await expectStatus(guard, Status.DEVIATION, 0n);
    });

    it("guardian pause blocks borrows; unpause restores them", async function () {
      const { guard, guardian, other } = await loadFixture(guardedFixture);
      await expect(guard.connect(other).setBorrowsPaused(true)).to.be.revertedWithCustomError(guard, "NotGuardian");
      await expect(guard.connect(guardian).setBorrowsPaused(true)).to.emit(guard, "BorrowsPausedSet").withArgs(true);
      await expectStatus(guard, Status.PAUSED);
      await guard.connect(guardian).setBorrowsPaused(false);
      await expectStatus(guard, Status.OK);
    });

    it("requires every guarded market to pass and reports the failing one", async function () {
      const { guard, guardian, keeper, sources } = await loadFixture(guardedFixture);
      await guard.connect(guardian).addMarket(1, await sources[1].getAddress());
      await expectStatus(guard, Status.NO_REFERENCE, 1n);
      await guard.connect(keeper).postReference(1, 3000n * E8, await nextTimestamp());
      await expectStatus(guard, Status.OK);
      await guard.connect(keeper).postReference(1, 2000n * E8, await nextTimestamp());
      await expectStatus(guard, Status.DEVIATION, 1n);
    });
  });

  describe("Core price liveness (R2-2)", function () {
    it("a frozen Core price blocks borrows after maxCorePriceAge even with a keeper posting matching references", async function () {
      const { guard, keeper } = await loadFixture(guardedFixture);
      const [, , , , , lastCoreChangeAt] = await guard.getMarket(0);
      // the keeper keeps posting a fresh, matching reference every 60 s while Core is frozen
      for (let t = (await now()) + 60n; t <= lastCoreChangeAt + MAX_CORE_PRICE_AGE; t += 60n) {
        await time.setNextBlockTimestamp(t);
        await guard.connect(keeper).postReference(0, 3000n * E8, t);
        await expectStatus(guard, Status.OK);
      }
      await time.setNextBlockTimestamp(lastCoreChangeAt + MAX_CORE_PRICE_AGE);
      await ethers.provider.send("evm_mine", []);
      await expectStatus(guard, Status.OK); // boundary inclusive

      const t = lastCoreChangeAt + MAX_CORE_PRICE_AGE + 1n;
      await time.setNextBlockTimestamp(t);
      await guard.connect(keeper).postReference(0, 3000n * E8, t);
      await expectStatus(guard, Status.CORE_PRICE_STALE, 0n);
      const [, , , refObservedAt, , unchanged] = await guard.getMarket(0);
      expect(refObservedAt).to.equal(t); // the reference itself is fresh
      expect(unchanged).to.equal(lastCoreChangeAt); // keeper posts cannot fake a Core change
    });

    it("anyone can poke; a recorded change re-opens borrows", async function () {
      const { guard, core, keeper, other } = await loadFixture(guardedFixture);
      await time.increase(MAX_CORE_PRICE_AGE + 1n);
      await guard.connect(keeper).postReference(0, 3000n * E8, await nextTimestamp());
      // postReference poked an unchanged price, so the Core price is stale now
      await expectStatus(guard, Status.CORE_PRICE_STALE, 0n);

      await core.setPrices(0, 300_100n, 300_100n); // live Core moved, nobody poked yet
      await expectStatus(guard, Status.CORE_PRICE_STALE, 0n); // un-poked change does not count

      // the change happened after the keeper's poke, so it is dated at that observation
      const [, , , , , , observedBefore] = await guard.getMarket(0);
      await expect(guard.connect(other).poke(0))
        .to.emit(guard, "CorePriceChanged")
        .withArgs(0, 3000n * E8, 3001n * E8, observedBefore);
      await expectStatus(guard, Status.OK);
      const [, , , , corePrice, lastCoreChangeAt, lastObservedAt] = await guard.getMarket(0);
      expect(corePrice).to.equal(3001n * E8);
      expect(lastCoreChangeAt).to.equal(observedBefore);
      expect(lastObservedAt).to.equal(await now());
    });

    it("observing the last pre-freeze move late does not stretch the freeze window (dated at the previous observation)", async function () {
      const { guard, core, keeper } = await loadFixture(guardedFixture);
      const [, , , , , , observedAt0] = await guard.getMarket(0); // keeper's post in the fixture
      await core.setPrices(0, 300_100n, 300_100n); // final move to 3001.00, then Core freezes

      // a hostile keeper waits almost maxRefAge before its next post (which pokes)
      let t = observedAt0 + MAX_REF_AGE - 1n;
      await time.setNextBlockTimestamp(t);
      await guard.connect(keeper).postReference(0, 3001n * E8, t);
      const [, , , , , lastCoreChangeAt] = await guard.getMarket(0);
      expect(lastCoreChangeAt).to.equal(observedAt0); // not t

      // matching heartbeats cannot keep borrows open past observedAt0 + maxCorePriceAge
      for (t += 60n; t <= observedAt0 + MAX_CORE_PRICE_AGE; t += 60n) {
        await time.setNextBlockTimestamp(t);
        await guard.connect(keeper).postReference(0, 3001n * E8, t);
        await expectStatus(guard, Status.OK);
      }
      t = observedAt0 + MAX_CORE_PRICE_AGE + 1n;
      await time.setNextBlockTimestamp(t);
      await guard.connect(keeper).postReference(0, 3001n * E8, t);
      await expectStatus(guard, Status.CORE_PRICE_STALE, 0n);
    });

    it("a poke with an unchanged price does not refresh liveness", async function () {
      const { guard, other } = await loadFixture(guardedFixture);
      const [, , , , , before] = await guard.getMarket(0);
      await time.increase(100);
      await expect(guard.connect(other).poke(0)).to.not.emit(guard, "CorePriceChanged");
      const [, , , , , after] = await guard.getMarket(0);
      expect(after).to.equal(before);
    });
  });

  describe("keeper powers are limited", function () {
    it("only the keeper posts references, with valid price and strictly increasing past observedAt", async function () {
      const { guard, keeper, other } = await loadFixture(guardedFixture);
      const ts = await nextTimestamp();
      await expect(guard.connect(other).postReference(0, 3000n * E8, ts)).to.be.revertedWithCustomError(guard, "NotKeeper");
      const [, , , observedAt] = await guard.getMarket(0);
      await expect(guard.connect(keeper).postReference(0, 3000n * E8, observedAt))
        .to.be.revertedWithCustomError(guard, "ObservedAtNotIncreasing");
      await expect(guard.connect(keeper).postReference(0, 3000n * E8, ts + 100n))
        .to.be.revertedWithCustomError(guard, "ObservedAtInFuture");
      await expect(guard.connect(keeper).postReference(0, 0, ts)).to.be.revertedWithCustomError(guard, "InvalidReferencePrice");
      await expect(guard.connect(keeper).postReference(0, 2n ** 128n, ts)).to.be.revertedWithCustomError(guard, "InvalidReferencePrice");
      await expect(guard.connect(keeper).postReference(7, 3000n * E8, ts)).to.be.revertedWithCustomError(guard, "MarketNotGuarded");
    });

    it("a hostile keeper can stop borrows but never block liquidations or move the Core price", async function () {
      const { guard, keeper, sources } = await loadFixture(guardedFixture);
      for (const price of [1n, 1500n * E8, 2n ** 128n - 1n]) {
        await guard.connect(keeper).postReference(0, price, await nextTimestamp());
        await expectStatus(guard, Status.DEVIATION, 0n); // also asserts isLiquidationAllowed() == true
        expect(await sources[0].latestAnswer()).to.equal(3000n * E8);
      }
    });

    it("the keeper cannot administer the guard", async function () {
      const { guard, keeper, sources } = await loadFixture(guardedFixture);
      await expect(guard.connect(keeper).setBorrowsPaused(false)).to.be.revertedWithCustomError(guard, "NotGuardian");
      await expect(guard.connect(keeper).setMaxRefAge(3600)).to.be.revertedWithCustomError(guard, "NotGuardian");
      await expect(guard.connect(keeper).setKeeper(keeper.address)).to.be.revertedWithCustomError(guard, "NotGuardian");
      await expect(guard.connect(keeper).removeMarket(0)).to.be.revertedWithCustomError(guard, "NotGuardian");
      await expect(guard.connect(keeper).addMarket(1, await sources[1].getAddress())).to.be.revertedWithCustomError(guard, "NotGuardian");
      await expect(guard.connect(keeper).transferGuardian(keeper.address)).to.be.revertedWithCustomError(guard, "NotGuardian");
    });
  });

  describe("guardian administration", function () {
    it("adds markets only with a matching, readable source", async function () {
      const { guard, guardian, sources, core } = await loadFixture(fixture);
      await expect(guard.connect(guardian).addMarket(1, await sources[0].getAddress()))
        .to.be.revertedWithCustomError(guard, "SourceMarketMismatch").withArgs(1, 0);
      await core.removeMarket(2);
      await expect(guard.connect(guardian).addMarket(2, await sources[2].getAddress()))
        .to.be.revertedWithCustomError(guard, "CoreReadFailed").withArgs(2);
      await expect(guard.connect(guardian).addMarket(0, ethers.ZeroAddress)).to.be.revertedWithCustomError(guard, "ZeroAddress");
      const addTx = await guard.connect(guardian).addMarket(0, await sources[0].getAddress());
      await expect(addTx).to.emit(guard, "MarketAdded").withArgs(0, await sources[0].getAddress(), 3000n * E8);
      const addedAt = BigInt((await ethers.provider.getBlock((await addTx.wait()).blockNumber)).timestamp);
      await expect(guard.connect(guardian).addMarket(0, await sources[0].getAddress()))
        .to.be.revertedWithCustomError(guard, "MarketAlreadyGuarded");
      const [guarded, source, refPrice, refObservedAt, corePrice, lastCoreChangeAt, lastObservedAt] = await guard.getMarket(0);
      expect([guarded, source, refPrice, refObservedAt, corePrice, lastCoreChangeAt, lastObservedAt]).to.deep.equal(
        [true, await sources[0].getAddress(), 0n, 0n, 3000n * E8, addedAt, addedAt],
      );
    });

    it("caps the number of markets and removes them with swap-and-pop", async function () {
      const { guard, guardian, sources } = await loadFixture(fixture);
      for (let id = 0; id < 8; id += 1) {
        await guard.connect(guardian).addMarket(id, await sources[id].getAddress());
      }
      await expect(guard.connect(guardian).addMarket(8, await sources[8].getAddress()))
        .to.be.revertedWithCustomError(guard, "TooManyMarkets");
      await guard.connect(guardian).removeMarket(0);
      expect(await guard.marketIds()).to.deep.equal([7n, 1n, 2n, 3n, 4n, 5n, 6n]);
      await guard.connect(guardian).removeMarket(6);
      expect(await guard.marketIds()).to.deep.equal([7n, 1n, 2n, 3n, 4n, 5n]);
      await guard.connect(guardian).removeMarket(7);
      expect(await guard.marketIds()).to.deep.equal([5n, 1n, 2n, 3n, 4n]);
      expect((await guard.getMarket(7))[0]).to.equal(false);
      await expect(guard.connect(guardian).removeMarket(7)).to.be.revertedWithCustomError(guard, "MarketNotGuarded");
      for (const id of [5, 1, 2, 3, 4]) await guard.connect(guardian).removeMarket(id);
      await expectStatus(guard, Status.NO_MARKETS); // removing every market blocks borrows
      // a re-added market starts without a reference
      await guard.connect(guardian).addMarket(3, await sources[3].getAddress());
      await expectStatus(guard, Status.NO_REFERENCE, 3n);
    });

    it("updates parameters within bounds and the keeper", async function () {
      const { guard, guardian, other } = await loadFixture(fixture);
      await expect(guard.connect(guardian).setMaxRefAge(30)).to.emit(guard, "MaxRefAgeUpdated").withArgs(30);
      await expect(guard.connect(guardian).setMaxRefAge(29)).to.be.revertedWithCustomError(guard, "OutOfBounds");
      await expect(guard.connect(guardian).setMaxDeviationBps(2000)).to.emit(guard, "MaxDeviationBpsUpdated").withArgs(2000);
      await expect(guard.connect(guardian).setMaxDeviationBps(2001)).to.be.revertedWithCustomError(guard, "OutOfBounds");
      await expect(guard.connect(guardian).setMaxCorePriceAge(30 * 86400)).to.emit(guard, "MaxCorePriceAgeUpdated");
      await expect(guard.connect(guardian).setMaxCorePriceAge(179)).to.be.revertedWithCustomError(guard, "OutOfBounds");
      await expect(guard.connect(guardian).setMaxCorePriceAge(180)).to.emit(guard, "MaxCorePriceAgeUpdated").withArgs(180);
      await expect(guard.connect(guardian).setKeeper(other.address)).to.emit(guard, "KeeperUpdated");
      expect(await guard.keeper()).to.equal(other.address);
    });

    it("transfers the guardian role in two steps", async function () {
      const { guard, guardian, other, keeper } = await loadFixture(fixture);
      await expect(guard.connect(guardian).transferGuardian(ethers.ZeroAddress)).to.be.revertedWithCustomError(guard, "ZeroAddress");
      await guard.connect(guardian).transferGuardian(other.address);
      expect(await guard.guardian()).to.equal(guardian.address);
      await expect(guard.connect(keeper).acceptGuardian()).to.be.revertedWithCustomError(guard, "NotPendingGuardian");
      await expect(guard.connect(other).acceptGuardian()).to.emit(guard, "GuardianTransferred").withArgs(guardian.address, other.address);
      expect(await guard.guardian()).to.equal(other.address);
      expect(await guard.pendingGuardian()).to.equal(ethers.ZeroAddress);
      await expect(guard.connect(guardian).setBorrowsPaused(true)).to.be.revertedWithCustomError(guard, "NotGuardian");
    });
  });
});
