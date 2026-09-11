const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");

describe("UpdatableAggregator", function () {
    const INITIAL = 100_000_000n; // $1
    const MAX_DEV = 2_000n; // 20%
    const MAX_STALE = 3600n;

    async function deploy() {
        const [owner, keeper, other] = await ethers.getSigners();
        const Feed = await ethers.getContractFactory("UpdatableAggregator");
        const feed = await Feed.deploy("LIT / USD", INITIAL, MAX_DEV, MAX_STALE);
        return { feed, owner, keeper, other };
    }

    it("serves the initial answer as fresh", async function () {
        const { feed } = await loadFixture(deploy);
        expect(await feed.latestAnswer()).to.equal(INITIAL);
        const round = await feed.latestRoundData();
        expect(round[1]).to.equal(INITIAL);
    });

    it("is still fresh at the exact heartbeat boundary", async function () {
        const { feed } = await loadFixture(deploy);
        await time.increase(MAX_STALE);
        expect(await feed.latestAnswer()).to.equal(INITIAL);
    });

    it("reverts when the price is stale by one second", async function () {
        const { feed } = await loadFixture(deploy);
        await time.increase(MAX_STALE + 1n);
        await expect(feed.latestAnswer()).to.be.revertedWithCustomError(feed, "PriceStale");
        await expect(feed.latestRoundData()).to.be.revertedWithCustomError(feed, "PriceStale");
    });

    it("rejects maxStaleness of zero at construction and via setter", async function () {
        const Feed = await ethers.getContractFactory("UpdatableAggregator");
        await expect(Feed.deploy("x", INITIAL, MAX_DEV, 0)).to.be.revertedWithCustomError(
            Feed,
            "InvalidMaxStaleness"
        );
        const { feed } = await loadFixture(deploy);
        await expect(feed.setMaxStaleness(0)).to.be.revertedWithCustomError(feed, "InvalidMaxStaleness");
    });

    it("rejects maxDeviationBps above 10000", async function () {
        const Feed = await ethers.getContractFactory("UpdatableAggregator");
        await expect(Feed.deploy("x", INITIAL, 10001, MAX_STALE)).to.be.revertedWithCustomError(
            Feed,
            "InvalidMaxDeviation"
        );
        const { feed } = await loadFixture(deploy);
        await expect(feed.setMaxDeviationBps(10001)).to.be.revertedWithCustomError(feed, "InvalidMaxDeviation");
    });

    it("rejects keeper updates beyond the deviation cap", async function () {
        const { feed, keeper } = await loadFixture(deploy);
        await feed.setKeeper(keeper.address, true);
        await expect(feed.connect(keeper).setAnswer(130_000_000n))
            .to.be.revertedWithCustomError(feed, "DeviationTooLarge");
    });

    it("allows owner emergency recovery beyond 20% without disabling the breaker", async function () {
        const { feed, keeper } = await loadFixture(deploy);
        await feed.setKeeper(keeper.address, true);
        await expect(feed.emergencySetAnswer(150_000_000n, "spot moved 50%"))
            .to.emit(feed, "EmergencyAnswerUpdated");
        expect(await feed.latestAnswer()).to.equal(150_000_000n);
        await expect(feed.connect(keeper).setAnswer(200_000_000n))
            .to.be.revertedWithCustomError(feed, "DeviationTooLarge");
    });

    it("requires a reason for emergency recovery", async function () {
        const { feed } = await loadFixture(deploy);
        await expect(feed.emergencySetAnswer(150_000_000n, "")).to.be.revertedWithCustomError(
            feed,
            "EmptyReason"
        );
    });

    it("uses two-step ownership", async function () {
        const { feed, owner, other } = await loadFixture(deploy);
        await expect(feed.transferOwnership(other.address))
            .to.emit(feed, "OwnershipTransferStarted")
            .withArgs(owner.address, other.address);
        expect(await feed.owner()).to.equal(owner.address);
        await expect(feed.connect(owner).acceptOwnership()).to.be.revertedWithCustomError(
            feed,
            "NotPendingOwner"
        );
        await feed.connect(other).acceptOwnership();
        expect(await feed.owner()).to.equal(other.address);
    });
});
