const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { READ_CORE, DEFAULT_STIPEND, etchReadCore, setMarket, deploy, now } = require("./helpers");

const E8 = 10n ** 8n;

describe("Lighter: LighterCorePriceSource", function () {
  async function fixture() {
    const core = await etchReadCore();
    await setMarket(core, 0, { indexPrice: 300_000n, markPrice: 310_000n }); // ETH 3000.00 (2 dec)
    await setMarket(core, 2048, { marketType: 1, indexPrice: 0n }); // spot
    await setMarket(core, 5, { marketType: 2, indexPrice: 300_000n }); // unknown type, non-zero price
    await setMarket(core, 6, { indexPrice: 0n }); // perp with zero price
    const source = await deploy(
      "LighterCorePriceSource", 0, 2, 100n * E8, 100_000n * E8, DEFAULT_STIPEND, "ETH / USD (Lighter index)",
    );
    const meter = await deploy("GasMeter");
    return { core, source, meter };
  }

  const sourceFor = (marketId, decimals = 2) =>
    deploy("LighterCorePriceSource", marketId, decimals, 1n, 2n ** 128n, DEFAULT_STIPEND, "test");

  it("returns the index price scaled to 8 decimals", async function () {
    const { source } = await loadFixture(fixture);
    expect(await source.latestAnswer()).to.equal(3000n * E8);
    expect(await source.decimals()).to.equal(8n);
    expect(await source.description()).to.equal("ETH / USD (Lighter index)");
    expect(await source.MARKET_ID()).to.equal(0n);
    expect(await source.PRICE_DECIMALS()).to.equal(2n);
    expect(await source.READ_GAS_STIPEND()).to.equal(DEFAULT_STIPEND);
  });

  it("uses indexPrice, never markPrice", async function () {
    const { core, source } = await loadFixture(fixture);
    await core.setPrices(0, 250_000n, 999_999n);
    expect(await source.latestAnswer()).to.equal(2500n * E8);
    const info = await source.marketInfo();
    expect(info.indexPrice).to.equal(250_000n);
    expect(info.markPrice).to.equal(999_999n);
  });

  it("reports block.timestamp for every timestamp field and has no round history", async function () {
    const { source } = await loadFixture(fixture);
    const ts = await now();
    expect(await source.latestTimestamp()).to.equal(ts);
    expect(await source.latestRound()).to.equal(ts);
    const round = await source.latestRoundData();
    expect(round.roundId).to.equal(ts);
    expect(round.answer).to.equal(3000n * E8);
    expect(round.startedAt).to.equal(ts);
    expect(round.updatedAt).to.equal(ts);
    expect(round.answeredInRound).to.equal(ts);
    await expect(source.getAnswer(1)).to.be.revertedWithCustomError(source, "NoRoundHistory");
    await expect(source.getTimestamp(1)).to.be.revertedWithCustomError(source, "NoRoundHistory");
    await expect(source.getRoundData(1)).to.be.revertedWithCustomError(source, "NoRoundHistory");
  });

  it("reverts on a failed read (unknown market) and burns only the stipend", async function () {
    const { source, meter } = await loadFixture(fixture);
    const unknown = await sourceFor(999);
    await expect(unknown.latestAnswer()).to.be.revertedWithCustomError(unknown, "ReadCoreFailed").withArgs(999);

    const data = unknown.interface.encodeFunctionData("latestAnswer");
    const [ok, gasUsed] = await meter.measure(await unknown.getAddress(), data, { gasLimit: 5_000_000 });
    expect(ok).to.equal(false);
    expect(gasUsed).to.be.gte(DEFAULT_STIPEND); // the failed read burned the stipend...
    expect(gasUsed).to.be.lt(DEFAULT_STIPEND + 30_000n); // ...but not the caller's remaining gas

    const [okValid, gasValid] = await meter.measure(await source.getAddress(), data, { gasLimit: 5_000_000 });
    expect(okValid).to.equal(true);
    expect(gasValid).to.be.lt(DEFAULT_STIPEND);

    // a caller with a tight budget (below the stipend × 64/63) still gets control back to
    // handle the failure: 63/64 clipping leaves the source enough to revert cleanly
    for (const budget of [60_000, 120_000, 200_000]) {
      const [okTight] = await meter.measure(await unknown.getAddress(), data, { gasLimit: budget });
      expect(okTight, `budget ${budget}`).to.equal(false);
    }
  });

  it("reverts when READ_CORE has no code (wrong chain): empty returndata", async function () {
    const { source } = await loadFixture(fixture);
    await network.provider.send("hardhat_setCode", [READ_CORE, "0x"]);
    await expect(source.latestAnswer()).to.be.revertedWithCustomError(source, "ReadCoreBadLength").withArgs(0, 0);
  });

  it("reverts unless returndata is exactly 320 bytes", async function () {
    const { source } = await loadFixture(fixture);
    const bad = await etchReadCore("contracts/lighter/test/LighterTestMocks.sol:MockReadCoreBadLength");
    for (const length of [0, 32, 288, 319, 321, 352, 640]) {
      await bad.configureResponseLength(length);
      await expect(source.latestAnswer())
        .to.be.revertedWithCustomError(source, "ReadCoreBadLength")
        .withArgs(0, length);
    }
    await bad.configureResponseLength(320); // positive control: same mock, right length
    expect(await source.latestAnswer()).to.equal(3000n * E8);
  });

  it("rejects non-perp markets by type: spot, and an unknown type with a non-zero price", async function () {
    await loadFixture(fixture);
    const spot = await sourceFor(2048);
    await expect(spot.latestAnswer()).to.be.revertedWithCustomError(spot, "NotPerpMarket").withArgs(2048, 1);
    const other = await sourceFor(5);
    await expect(other.latestAnswer()).to.be.revertedWithCustomError(other, "NotPerpMarket").withArgs(5, 2);
  });

  it("reverts on a zero index price instead of returning 0", async function () {
    await loadFixture(fixture);
    const zero = await sourceFor(6);
    await expect(zero.latestAnswer()).to.be.revertedWithCustomError(zero, "ZeroPrice").withArgs(6);
    await expect(zero.latestRoundData()).to.be.revertedWithCustomError(zero, "ZeroPrice");
  });

  it("enforces inclusive sanity bounds", async function () {
    const { core, source } = await loadFixture(fixture);
    await core.setPrices(0, 10_000n, 10_000n); // 100.00 = MIN
    expect(await source.latestAnswer()).to.equal(100n * E8);
    await core.setPrices(0, 9_999n, 9_999n); // 99.99
    await expect(source.latestAnswer())
      .to.be.revertedWithCustomError(source, "PriceOutOfBounds")
      .withArgs(0, 9_999_000_000n, 100n * E8, 100_000n * E8);
    await core.setPrices(0, 10_000_000n, 10_000_000n); // 100000.00 = MAX
    expect(await source.latestAnswer()).to.equal(100_000n * E8);
    await core.setPrices(0, 10_000_001n, 10_000_001n);
    await expect(source.latestAnswer()).to.be.revertedWithCustomError(source, "PriceOutOfBounds");
  });

  it("scales every priceDecimals from 0 to 18 (rounding down)", async function () {
    const { core } = await loadFixture(fixture);
    const cases = [
      [0, 3000n, 3000n * E8],
      [1, 30_000n, 3000n * E8],
      [2, 300_012n, 300_012_000_000n],
      [6, 3_000_123_456n, 300_012_345_600n],
      [8, 300_012_345_678n, 300_012_345_678n],
      [9, 3_000_123_456_789n, 300_012_345_678n], // drops the last digit
      [12, 3_000_123_456_789_999n, 300_012_345_678n],
      [18, 3_000_123_456_789_012_345n, 300_012_345n], // 3.000123456789012345 at 18 dec
    ];
    for (const [decimals, raw, expected] of cases) {
      await core.setPrices(0, raw, raw);
      const src = await sourceFor(0, decimals);
      expect(await src.latestAnswer(), `decimals ${decimals}`).to.equal(expected);
    }
    // a value that scales down to 0 is out of bounds, never returned as 0
    await core.setPrices(0, 9n, 9n);
    const tiny = await sourceFor(0, 18);
    await expect(tiny.latestAnswer()).to.be.revertedWithCustomError(tiny, "PriceOutOfBounds");
  });

  it("validates constructor parameters", async function () {
    const factory = await ethers.getContractFactory("LighterCorePriceSource");
    const ok = [0, 2, 1n, 10n, DEFAULT_STIPEND, "x"];
    const bad = [
      [0, 19, 1n, 10n, DEFAULT_STIPEND, "x"], // decimals > 18
      [0, 2, 0n, 10n, DEFAULT_STIPEND, "x"], // min 0
      [0, 2, 11n, 10n, DEFAULT_STIPEND, "x"], // min > max
      [0, 2, 1n, 2n ** 255n, DEFAULT_STIPEND, "x"], // max > int256 max
      [0, 2, 1n, 10n, 24_999n, "x"], // stipend too small
      [0, 2, 1n, 10n, 1_000_001n, "x"], // stipend too large
    ];
    await factory.deploy(...ok);
    for (const args of bad) {
      await expect(factory.deploy(...args)).to.be.revertedWithCustomError(factory, "InvalidConfig");
    }
  });
});

describe("Lighter: FixedPriceSource", function () {
  it("returns its constant price with block.timestamp", async function () {
    const usd = await deploy("FixedPriceSource", E8, "USDC / USD (fixed)");
    expect(await usd.latestAnswer()).to.equal(E8);
    expect(await usd.decimals()).to.equal(8n);
    expect(await usd.description()).to.equal("USDC / USD (fixed)");
    const round = await usd.latestRoundData();
    expect(round.answer).to.equal(E8);
    expect(round.updatedAt).to.equal(await now());
    await expect(usd.getAnswer(0)).to.be.revertedWithCustomError(usd, "NoRoundHistory");
  });

  it("rejects a zero or out-of-range price", async function () {
    const factory = await ethers.getContractFactory("FixedPriceSource");
    await expect(factory.deploy(0, "x")).to.be.revertedWithCustomError(factory, "InvalidPrice");
    await expect(factory.deploy(2n ** 255n, "x")).to.be.revertedWithCustomError(factory, "InvalidPrice");
  });
});
