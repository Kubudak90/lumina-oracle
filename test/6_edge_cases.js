const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
  
describe("Aggregator-ReadPrice", function () {
    async function deploy() {
        const [owner, keeper, user] = await ethers.getSigners();

        const Aggregator = await ethers.getContractFactory("Aggregator");
        const aggregator = await Aggregator.deploy(owner.address);

        await aggregator.toggleKeeper(keeper.address)
        await aggregator.setAsset("0x0000000000000000000000000000000000000024", false, 1, 0, "100000000", false)

        return { aggregator, owner, keeper, user };
    }
  
    it("should add new round data after 1000 years delay", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);

        await time.increase(60 * 60 * 24 * 365 * 1000)

        const asset = "0x0000000000000000000000000000000000000024"
        const price = "100000000"
        const beforeSubmitTimestamp = await time.latest();
        await aggregator.connect(keeper).submitRoundData([asset], [price], beforeSubmitTimestamp)

        expect(await aggregator.getPrice(asset)).to.equal(price)
    });

    it("should handle $100B price", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);

        // Register a separate asset with a $100B initial price to test large value handling
        const asset = "0x0000000000000000000000000000000000000099"
        const price = "10000000000000000000"
        await aggregator.setAsset(asset, false, 2, 0, price, false)

        //increase time over EMA window
        await time.increase(60 * 60 * 12)

        const beforeSubmitTimestamp = await time.latest();
        await aggregator.connect(keeper).submitRoundData([asset], [price], beforeSubmitTimestamp)

        expect(await aggregator.getPrice(asset)).to.equal(price)
    });

    it("should revert on 0 price", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);

        //increase time over EMA window
        await time.increase(60 * 60 * 12)

        const asset = "0x0000000000000000000000000000000000000024"
        const price = "0"
        const beforeSubmitTimestamp = await time.latest();
        await expect(
            aggregator.connect(keeper).submitRoundData([asset], [price], beforeSubmitTimestamp)
        ).to.be.revertedWith("price must be > 0")
    });
});