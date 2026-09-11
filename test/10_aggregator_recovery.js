const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");

describe("Aggregator recovery and per-asset system blocks", function () {
    const ASSET_A = "0x00000000000000000000000000000000000000A1";
    const ASSET_B = "0x00000000000000000000000000000000000000B2";
    const PRICE = 100_000_000n;

    async function deploy() {
        const [owner, keeper] = await ethers.getSigners();
        const MockSys = await ethers.getContractFactory("MockSystemOracle");
        const sys = await MockSys.deploy();
        await sys.setValues(10, [0], [1_000_000n, 2_000_000n], [0]);

        const Aggregator = await ethers.getContractFactory("Aggregator");
        const aggregator = await Aggregator.deploy(sys.target);
        await aggregator.toggleKeeper(keeper.address);
        return { aggregator, sys, owner, keeper };
    }

    it("lets owner recover a genuine move beyond 20%", async function () {
        const { aggregator } = await loadFixture(deploy);
        await aggregator.setAsset(ASSET_A, false, 1, 0, PRICE, false);
        await expect(aggregator.setAsset(ASSET_A, false, 1, 0, 150_000_000n, true))
            .to.be.revertedWith("setAsset: price deviation too large");
        await expect(aggregator.emergencySetAssetPrice(ASSET_A, 150_000_000n, "spot jump"))
            .to.emit(aggregator, "EmergencyPriceRecovered")
            .withArgs(ASSET_A, PRICE, 150_000_000n, "spot jump");
        expect(await aggregator.getPrice(ASSET_A)).to.equal(150_000_000n);
    });

    it("tracks last seen system block per asset", async function () {
        const { aggregator, sys, keeper } = await loadFixture(deploy);
        await aggregator.setAsset(ASSET_A, true, 0, 0, PRICE, false);
        await aggregator.setAsset(ASSET_B, true, 1, 0, PRICE, false);

        await aggregator.connect(keeper).updatePerpTimestamps([ASSET_A]);
        expect(await aggregator.lastSeenSysBlockByAsset(ASSET_A)).to.equal(10n);
        expect(await aggregator.lastSeenSysBlockByAsset(ASSET_B)).to.equal(0);

        await expect(aggregator.connect(keeper).updatePerpTimestamps([ASSET_A]))
            .to.be.revertedWith("system oracle not updated");
        await aggregator.connect(keeper).updatePerpTimestamps([ASSET_B]);
        expect(await aggregator.lastSeenSysBlockByAsset(ASSET_B)).to.equal(10n);

        await sys.setValues(11, [0], [1_000_000n, 2_000_000n], [0]);
        await aggregator.connect(keeper).updatePerpTimestamps([ASSET_A, ASSET_B]);
        expect(await aggregator.lastSeenSysBlockByAsset(ASSET_A)).to.equal(11n);
        expect(await aggregator.lastSeenSysBlockByAsset(ASSET_B)).to.equal(11n);
    });

    it("does not fabricate a timestamp for a never-updated perp asset", async function () {
        const { aggregator } = await loadFixture(deploy);
        await aggregator.setAsset(ASSET_A, true, 0, 0, PRICE, false);
        expect(await aggregator.getUpdateTimestamp(ASSET_A)).to.equal(0);
        await expect(aggregator.getPrice(ASSET_A)).to.be.revertedWith("perp oracle never updated");
    });

    it("rejects future keeper timestamps with a named error", async function () {
        const { aggregator, keeper } = await loadFixture(deploy);
        await aggregator.setAsset(ASSET_A, false, 1, 0, PRICE, false);
        const future = (await time.latest()) + 1000;
        await expect(
            aggregator.connect(keeper).submitRoundData([ASSET_A], [PRICE], future)
        ).to.be.revertedWith("submitRoundData: future timestamp");
    });

    it("rejects duplicate assets in a keeper batch", async function () {
        const { aggregator, keeper } = await loadFixture(deploy);
        await aggregator.setAsset(ASSET_A, false, 1, 0, PRICE, false);
        await time.increase(1);
        const ts = await time.latest();
        await expect(
            aggregator.connect(keeper).submitRoundData([ASSET_A, ASSET_A], [PRICE, PRICE], ts)
        ).to.be.revertedWith("duplicate asset");
    });
});
