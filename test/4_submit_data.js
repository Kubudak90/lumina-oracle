const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");

describe("Aggregator-SubmitData", function () {
    async function deploy() {
        const [owner, keeper, user] = await ethers.getSigners();

        const Aggregator = await ethers.getContractFactory("Aggregator");
        const aggregator = await Aggregator.deploy(owner.address);

        await aggregator.toggleKeeper(keeper.address)
        await aggregator.setAsset("0x0000000000000000000000000000000000000024", false, 1, 1, "100000000", false)

        return { aggregator, owner, keeper, user };
    }

    it("should revert: only keepers can submit data", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);

        const asset = "0x0000000000000000000000000000000000000024"
        const price = "100000000"
        await time.increase(1)
        const timestamp = await time.latest()
        await expect(
            aggregator.connect(user).submitRoundData([asset], [price], timestamp)
        ).to.be.revertedWith("only keepers")
    });

    it("should submit data", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);

        const asset = "0x0000000000000000000000000000000000000024"
        const price = "100000000"
        await time.increase(1)
        const timestamp = await time.latest()
        await expect(aggregator.connect(keeper).submitRoundData([asset], [price], timestamp))
            .to.emit(aggregator, "RoundDataSubmitted")
            .withArgs([asset], [price], anyValue)

        expect(await aggregator.getPrice(asset)).to.be.above("0")
    });

    it("should revert: array length missmatch", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);

        const asset = "0x0000000000000000000000000000000000000024"
        const prices = ["100000000", "2"]
        await time.increase(1)
        const timestamp = await time.latest()
        await expect(aggregator.connect(keeper).submitRoundData([asset], prices, timestamp)).to.be.revertedWith("submitRoundData: length mismatch")
    });

    it("should revert: expired data", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);
        const asset = "0x0000000000000000000000000000000000000024"
        const maxDelay = Number(await aggregator.MAX_TIMESTAMP_DELAY_SECONDS())
        const timestamp = (await time.latest()) - maxDelay - 1
        await expect(aggregator.connect(keeper).submitRoundData([asset], ["100000000"], timestamp)).to.be.revertedWith("submitRoundData: expired")
    });

    it("should revert: timestamp in the future", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);
        const asset = "0x0000000000000000000000000000000000000024"
        const timestamp = (await time.latest()) + 1000
        await expect(aggregator.connect(keeper).submitRoundData([asset], ["100000000"], timestamp)).to.be.revertedWithPanic("0x11") //overflow
    });

    it("should calculate correct EMA on first round", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);
        const asset = "0x0000000000000000000000000000000000000024"

        const detailsBeforeUpdate = await aggregator.assetDetails(asset)

        await time.increase(1)
        const beforeSubmitTimestamp = await time.latest();
        const newPrice = 100000000
        await aggregator.connect(keeper).submitRoundData([asset], [newPrice], beforeSubmitTimestamp)

        //calculate EMA
        let currentTimestamp = await time.latest();
        let tau = Number(await aggregator.EMA_WINDOW_SECONDS())
        let w = Math.exp(-(Number(currentTimestamp) - Number(detailsBeforeUpdate.lastTimestamp)) / tau);
        let expectedEma = Math.floor(Number(detailsBeforeUpdate.ema) * w + newPrice * (1 - w))

        expect(await aggregator.getPrice(asset)).to.equal(expectedEma)
    });

    it("should calculate correct EMA during multiple rounds (within deviation bounds)", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);
        const asset = "0x0000000000000000000000000000000000000024"

        // Prices must stay within 20% deviation of running EMA (initial EMA = 100000000)
        const prices = [105000000, 115000000, 100000000, 90000000, 108000000]
        const timeIncrease = 60

        for (let i in prices){
            const detailsBeforeUpdate = await aggregator.assetDetails(asset)
            await time.increase(timeIncrease)
            let beforeSubmitTimestamp = await time.latest();
            await aggregator.connect(keeper).submitRoundData([asset], [prices[i]], beforeSubmitTimestamp)

            //calculate EMA
            let currentTimestamp = await time.latest();
            let tau = Number(await aggregator.EMA_WINDOW_SECONDS())
            let w = Math.exp(-(Number(currentTimestamp) - Number(detailsBeforeUpdate.lastTimestamp)) / tau);
            let expectedEma = Math.floor(Number(detailsBeforeUpdate.ema) * w + prices[i] * (1 - w))

            expect(await aggregator.getPrice(asset)).to.equal(expectedEma)
        }
    });

    it("should calculate correct EMA during multiple rounds with different intervals", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);
        const asset = "0x0000000000000000000000000000000000000024"

        // Prices within 20% deviation bounds
        const prices = [105000000, 110000000, 95000000, 100000000, 115000000, 98000000, 102000000]
        const timeIncrease = [50, 60, 110, 40, 500, 400, 11]

        for (let i in prices){
            await time.increase(timeIncrease[i])
            let beforeSubmitTimestamp = await time.latest();
            const detailsBeforeUpdate = await aggregator.assetDetails(asset)
            await aggregator.connect(keeper).submitRoundData([asset], [prices[i]], beforeSubmitTimestamp)

            //calculate EMA
            let currentTimestamp = await time.latest();
            let tau = Number(await aggregator.EMA_WINDOW_SECONDS())
            let w = Math.exp(-(Number(currentTimestamp) - Number(detailsBeforeUpdate.lastTimestamp)) / tau);
            let expectedEma = Math.floor(Number(detailsBeforeUpdate.ema) * w + prices[i] * (1 - w))

            expect(await aggregator.getPrice(asset)).to.equal(expectedEma)
        }
    });

    it("should calculate correct EMA with multiple assets", async function () {
        const { aggregator, keeper, user } = await loadFixture(deploy);
        const assets = [
            "0x0000000000000000000000000000000000000024",
            "0x0000000000000000000000000000000000000025",
            "0x0000000000000000000000000000000000000026",
            "0x0000000000000000000000000000000000000027"
        ]
        // Create assets 0x25-0x27 (0x24 already exists from deploy fixture)
        await aggregator.setAsset(assets[1], false, 2, 1, "100000000", false)
        await aggregator.setAsset(assets[2], false, 3, 1, "100000000", false)
        await aggregator.setAsset(assets[3], false, 4, 1, "100000000", false)

        // Prices within 20% deviation of 100000000
        const prices = [
            [ 105000000, 110000000, 95000000, 108000000 ],
            [ 110000000, 100000000, 105000000, 100000000 ],
            [ 100000000, 115000000, 110000000, 95000000 ],
        ]
        const timeIncrease = [50, 60, 110]

        for (let i in prices){
            await time.increase(timeIncrease[i])
            let beforeSubmitTimestamp = await time.latest();
            const detailsBeforeUpdate = await Promise.all(assets.map(async (e) => {return await aggregator.assetDetails(e)}))
            await aggregator.connect(keeper).submitRoundData(assets, prices[i], beforeSubmitTimestamp)

            for (let j in assets){
                //calculate EMA for each asset
                let currentTimestamp = await time.latest();
                let tau = Number(await aggregator.EMA_WINDOW_SECONDS())
                let w = Math.exp(-(Number(currentTimestamp) - Number(detailsBeforeUpdate[j].lastTimestamp)) / tau);
                let expectedEma = Math.floor(Number(detailsBeforeUpdate[j].ema) * w + prices[i][j] * (1 - w))

                expect(await aggregator.getPrice(assets[j])).to.equal(expectedEma)
            }
        }
    });
});
