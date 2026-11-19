const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { DEFAULT_STIPEND, etchReadCore, setMarket, deploy, now } = require("./helpers");

const E8 = 10n ** 8n;

/** FraxLend DualOracleChainlinkUniV3 formula with 8-decimal multiply/divide feeds. */
function fraxLendRate(assetPrice, collateralPrice, assetDecimals, collateralDecimals) {
  const normalization = 10n ** (18n + 8n - 8n + BigInt(assetDecimals) - BigInt(collateralDecimals));
  return (10n ** 36n * assetPrice) / collateralPrice / normalization;
}

describe("Lighter: LighterDualOracle", function () {
  async function fixture() {
    const [deployer, guardian, keeper, provider] = await ethers.getSigners();
    const core = await etchReadCore();
    await setMarket(core, 0, { indexPrice: 300_000n }); // ETH 3000.00
    const ethSource = await deploy("LighterCorePriceSource", 0, 2, 100n * E8, 100_000n * E8, DEFAULT_STIPEND, "ETH");
    const usdSource = await deploy("FixedPriceSource", E8, "USDC");
    const usdc = await deploy("MockDecimalsToken", 6);
    const weth = await deploy("MockDecimalsToken", 18);
    const mockGuard = await deploy("MockBorrowGuard");
    const addr = (c) => c.getAddress();

    const usdcWeth = await deploy( // asset USDC, collateral WETH
      "LighterDualOracle", await addr(usdc), await addr(weth), await addr(usdSource), await addr(ethSource),
      await addr(mockGuard), "Lighter USDC/WETH",
    );
    const wethUsdc = await deploy( // asset WETH, collateral USDC
      "LighterDualOracle", await addr(weth), await addr(usdc), await addr(ethSource), await addr(usdSource),
      await addr(mockGuard), "Lighter WETH/USDC",
    );
    return { deployer, guardian, keeper, provider, core, ethSource, usdSource, usdc, weth, mockGuard, usdcWeth, wethUsdc };
  }

  it("prices asset USDC / collateral WETH: collateral units per asset unit × 1e18", async function () {
    const { usdcWeth } = await loadFixture(fixture);
    const [isBadData, low, high] = await usdcWeth.getPrices();
    expect(isBadData).to.equal(false);
    expect(low).to.equal(high);
    // 1 USDC unit (1e-6 USD) buys 1e-6/3000 ETH = 333333333.33 wei → × 1e18
    expect(low).to.equal(10n ** 30n / 3000n);
    expect(low).to.equal(fraxLendRate(E8, 3000n * E8, 6, 18));
  });

  it("prices asset WETH / collateral USDC", async function () {
    const { wethUsdc } = await loadFixture(fixture);
    const [isBadData, low, high] = await wethUsdc.getPrices();
    expect(isBadData).to.equal(false);
    expect(low).to.equal(high);
    expect(low).to.equal(3_000_000_000n); // 1 wei of ETH = 3e-9 USDC units → × 1e18
    expect(low).to.equal(fraxLendRate(3000n * E8, E8, 18, 6));
  });

  it("follows the READ_CORE index price", async function () {
    const { core, usdcWeth, wethUsdc } = await loadFixture(fixture);
    await core.setPrices(0, 150_000n, 999_999n); // ETH 1500.00 index (mark ignored)
    expect((await wethUsdc.getPrices())[1]).to.equal(1_500_000_000n);
    expect((await usdcWeth.getPrices())[1]).to.equal(10n ** 30n / 1500n);
  });

  it("returns whole-token rates from getPricesNormalized", async function () {
    const { usdcWeth, wethUsdc } = await loadFixture(fixture);
    expect(await usdcWeth.NORMALIZATION_0()).to.equal(12n);
    expect(await wethUsdc.NORMALIZATION_0()).to.equal(-12n);
    expect((await usdcWeth.getPricesNormalized())[1]).to.equal(10n ** 30n / 3000n / 10n ** 12n); // WETH per USDC
    expect((await wethUsdc.getPricesNormalized())[1]).to.equal(3000n * 10n ** 18n); // USDC per WETH
  });

  it("treats any guard failure as bad data and still returns the rate (liquidations keep working)", async function () {
    const { usdcWeth, mockGuard } = await loadFixture(fixture);
    const [, rate] = await usdcWeth.getPrices();
    // revert, empty return, non-bool word (2), burn all gas, 64-byte return, 64-KiB return
    for (const mode of [1, 2, 3, 4, 5, 6]) {
      await mockGuard.setMode(mode);
      expect(await usdcWeth.getPrices({ gasLimit: 3_000_000 }), `mode ${mode}`).to.deep.equal([true, rate, rate]);
    }
    await mockGuard.setMode(0);
    expect(await usdcWeth.getPrices()).to.deep.equal([false, rate, rate]);
  });

  it("a hostile guard costs a liquidation-like caller at most GUARD_CALL_GAS extra gas", async function () {
    const { usdcWeth, mockGuard } = await loadFixture(fixture);
    const consumer = await deploy("PriceConsumer");
    const work = 200_000n; // gas the caller still needs after getPrices (rest of a liquidation)
    const [, rate] = await usdcWeth.getPrices();
    // healthy guard: a modest budget suffices
    expect(await consumer.consume(usdcWeth.target, work, { gasLimit: 400_000 })).to.equal(rate);
    // gas-burning guard, 64-KiB response, and a response as large as the 1M cap can pay for:
    // cap + the caller's own needs always suffices (returndata copy is bounded to 32 bytes)
    for (const mode of [4, 6, 7]) {
      await mockGuard.setMode(mode);
      expect(await consumer.consume(usdcWeth.target, work, { gasLimit: 1_350_000 }), `mode ${mode}`).to.equal(rate);
    }
  });

  it("sets isBadData from the guard without touching the rate (guard false or reverting)", async function () {
    const { usdcWeth, mockGuard } = await loadFixture(fixture);
    const [, rate] = await usdcWeth.getPrices();
    await mockGuard.setAllowed(false);
    expect(await usdcWeth.getPrices()).to.deep.equal([true, rate, rate]);
    expect(await usdcWeth.getPricesNormalized()).to.deep.equal([true, rate / 10n ** 12n, rate / 10n ** 12n]);
    await mockGuard.setAllowed(true);
    await mockGuard.setShouldRevert(true);
    expect(await usdcWeth.getPrices()).to.deep.equal([true, rate, rate]);
  });

  it("a hostile keeper changes only isBadData, never the exchange rate", async function () {
    const { guardian, keeper, provider, ethSource, usdSource, usdc, weth } = await loadFixture(fixture);
    const guard = await deploy("LuminaPriceGuard", provider.address, guardian.address, keeper.address, 180, 300, 600);
    await guard.connect(guardian).addMarket(0, await ethSource.getAddress());
    const oracle = await deploy(
      "LighterDualOracle", await weth.getAddress(), await usdc.getAddress(), await ethSource.getAddress(),
      await usdSource.getAddress(), await guard.getAddress(), "WETH/USDC",
    );
    await guard.connect(keeper).postReference(0, 3000n * E8, (await now()) + 1n);
    expect(await oracle.getPrices()).to.deep.equal([false, 3_000_000_000n, 3_000_000_000n]);
    for (const hostile of [1n, 6000n * E8, 2n ** 128n - 1n]) {
      await guard.connect(keeper).postReference(0, hostile, (await now()) + 1n);
      expect(await oracle.getPrices()).to.deep.equal([true, 3_000_000_000n, 3_000_000_000n]);
    }
  });

  it("reverts when a price source fails (no price, no fallback)", async function () {
    const { core, usdcWeth, wethUsdc, ethSource } = await loadFixture(fixture);
    await core.removeMarket(0);
    await expect(usdcWeth.getPrices()).to.be.revertedWithCustomError(ethSource, "ReadCoreFailed");
    await expect(wethUsdc.getPricesNormalized()).to.be.revertedWithCustomError(ethSource, "ReadCoreFailed");
  });

  it("rejects non-positive source answers and a rate that rounds to zero", async function () {
    const { usdc, weth, mockGuard } = await loadFixture(fixture);
    const assetSource = await deploy("MockLighterPriceSource", 0, E8);
    const collateralSource = await deploy("MockLighterPriceSource", 0, E8);
    const coarse = await deploy("MockDecimalsToken", 0);
    const oracle = await deploy(
      "LighterDualOracle", await weth.getAddress(), await coarse.getAddress(), await assetSource.getAddress(),
      await collateralSource.getAddress(), await mockGuard.getAddress(), "x",
    );
    await assetSource.setAnswer(0);
    await expect(oracle.getPrices()).to.be.revertedWithCustomError(oracle, "InvalidSourcePrice");
    await assetSource.setAnswer(-1);
    await expect(oracle.getPrices()).to.be.revertedWithCustomError(oracle, "InvalidSourcePrice");
    // asset 18 dec, collateral 0 dec: rate = 1e36 × pa / (pc × 1e36) = 0 when pa < pc
    await assetSource.setAnswer(1);
    await expect(oracle.getPrices()).to.be.revertedWithCustomError(oracle, "ZeroRate");
    await assetSource.setAnswer(E8);
    expect((await oracle.getPrices())[1]).to.equal(1n);
    void usdc;
  });

  it("validates constructor inputs", async function () {
    const { usdc, weth, ethSource, usdSource, mockGuard } = await loadFixture(fixture);
    const factory = await ethers.getContractFactory("LighterDualOracle");
    const args = [usdc, weth, usdSource, ethSource, mockGuard].map((c) => c.target);
    for (let i = 0; i < args.length; i += 1) {
      const bad = [...args];
      bad[i] = ethers.ZeroAddress;
      await expect(factory.deploy(...bad, "x")).to.be.revertedWithCustomError(factory, "ZeroAddress");
    }
    const odd = await deploy("MockDecimalsToken", 19);
    await expect(factory.deploy(odd.target, weth.target, usdSource.target, ethSource.target, mockGuard.target, "x"))
      .to.be.revertedWithCustomError(factory, "UnsupportedDecimals");

    // wiring checks: an EOA or a malformed guard, or a source that cannot price, is rejected
    const [eoa] = await ethers.getSigners();
    await expect(factory.deploy(usdc.target, weth.target, usdSource.target, ethSource.target, eoa.address, "x"))
      .to.be.revertedWithCustomError(factory, "InvalidGuard");
    for (const mode of [1, 2, 3, 5]) {
      await mockGuard.setMode(mode);
      await expect(factory.deploy(usdc.target, weth.target, usdSource.target, ethSource.target, mockGuard.target, "x"))
        .to.be.revertedWithCustomError(factory, "InvalidGuard");
    }
    await mockGuard.setMode(0);
    const deadSource = await deploy("MockLighterPriceSource", 0, 0);
    await expect(factory.deploy(usdc.target, weth.target, deadSource.target, ethSource.target, mockGuard.target, "x"))
      .to.be.revertedWithCustomError(factory, "InvalidSourcePrice");
  });

  it("implements the IDualOracle getters and ERC165", async function () {
    const { usdcWeth, usdc, weth } = await loadFixture(fixture);
    expect(await usdcWeth.ORACLE_PRECISION()).to.equal(10n ** 18n);
    expect(await usdcWeth.decimals()).to.equal(18n);
    expect(await usdcWeth.name()).to.equal("Lighter USDC/WETH");
    expect(await usdcWeth.BASE_TOKEN_0()).to.equal(usdc.target);
    expect(await usdcWeth.BASE_TOKEN_1()).to.equal(usdc.target);
    expect(await usdcWeth.QUOTE_TOKEN_0()).to.equal(weth.target);
    expect(await usdcWeth.QUOTE_TOKEN_1()).to.equal(weth.target);
    expect(await usdcWeth.BASE_TOKEN_0_DECIMALS()).to.equal(6n);
    expect(await usdcWeth.BASE_TOKEN_1_DECIMALS()).to.equal(6n);
    expect(await usdcWeth.QUOTE_TOKEN_0_DECIMALS()).to.equal(18n);
    expect(await usdcWeth.QUOTE_TOKEN_1_DECIMALS()).to.equal(18n);
    expect(await usdcWeth.NORMALIZATION_1()).to.equal(12n);

    const iface = (await ethers.getContractAt("contracts/lighter/interfaces/IDualOracle.sol:IDualOracle", usdcWeth.target)).interface;
    let interfaceId = 0n;
    iface.forEachFunction((fragment) => {
      if (fragment.name !== "supportsInterface") interfaceId ^= BigInt(fragment.selector);
    });
    const idHex = ethers.toBeHex(interfaceId, 4);
    expect(await usdcWeth.supportsInterface(idHex)).to.equal(true);
    expect(await usdcWeth.supportsInterface("0x01ffc9a7")).to.equal(true); // IERC165
    expect(await usdcWeth.supportsInterface("0xffffffff")).to.equal(false);
  });
});
