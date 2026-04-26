const hre = require("hardhat");

const { verify } = require("../utils/verify")

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    // Use deployer address as system oracle placeholder for Base Sepolia
    const aggregator = await hre.ethers.deployContract("Aggregator", [deployer.address]);

    await aggregator.waitForDeployment();
    await verify(aggregator.target, [])

    return aggregator
}

module.exports.main = main