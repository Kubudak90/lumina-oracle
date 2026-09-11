const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");

describe("DualFallbackOracle health", function () {
    const HEARTBEAT = 3600;

    async function deploy() {
        const [owner] = await ethers.getSigners();
        const Feed = await ethers.getContractFactory("MockAggregatorFeed");
        const now = await time.latest();
        const primary = await Feed.deploy(100_000_000n, now);
        const fallback = await Feed.deploy(101_000_000n, now);
        const emergency = await Feed.deploy(99_000_000n, now);
        const ACL = await ethers.getContractFactory("MockACLManager");
        const acl = await ACL.deploy();
        const Dual = await ethers.getContractFactory("DualFallbackOracle");
        const dual = await Dual.deploy(
            primary.target,
            fallback.target,
            emergency.target,
            acl.target,
            "TEST",
            HEARTBEAT,
            HEARTBEAT
        );
        return { dual, primary, fallback, emergency, owner };
    }

    it("returns primary when it is healthy", async function () {
        const { dual } = await loadFixture(deploy);
        expect(await dual.latestAnswer()).to.equal(100_000_000n);
    });

    it("uses fallback when primary is stale by one second", async function () {
        const { dual, primary, fallback } = await loadFixture(deploy);
        const now = await time.latest();
        await primary.set(100_000_000n, now - HEARTBEAT - 1);
        await fallback.set(101_000_000n, now);
        expect(await dual.latestAnswer()).to.equal(101_000_000n);
    });

    it("treats updatedAt == 0 and future timestamps as unhealthy", async function () {
        const { dual, primary, fallback } = await loadFixture(deploy);
        await primary.set(100_000_000n, 0);
        await fallback.set(101_000_000n, (await time.latest()) + 10_000);
        await expect(dual.latestAnswer()).to.be.revertedWithCustomError(dual, "BothOraclesUnhealthy");
    });

    it("uses fallback when primary reverts", async function () {
        const { dual, primary } = await loadFixture(deploy);
        await primary.setRevert(true);
        expect(await dual.latestAnswer()).to.equal(101_000_000n);
    });

    it("reverts when both sources revert", async function () {
        const { dual, primary, fallback } = await loadFixture(deploy);
        await primary.setRevert(true);
        await fallback.setRevert(true);
        await expect(dual.latestAnswer()).to.be.revertedWithCustomError(dual, "BothOraclesUnhealthy");
    });
});
