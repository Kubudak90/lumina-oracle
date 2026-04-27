const hre = require("hardhat");

const USDC = "0x57d6EB79ea08D10d7e03865cb1820f01F82255c4";
const LIT = "0xDf2B23A45B9a451c002c27F83e9e55da5efdc992";
const USDC_AMOUNT = 10_000n * 10n ** 6n; // 10,000 USDC (6 decimals)
const LIT_AMOUNT = 5n * 10n ** 18n;       // 5 LIT
const COOLDOWN = 6 * 60 * 60;             // 6 hours

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Network: ", hre.network.name);

    // 1. Deploy LuminaFaucet
    const Faucet = await hre.ethers.deployContract("LuminaFaucet", [
        USDC, LIT, USDC_AMOUNT, LIT_AMOUNT, COOLDOWN,
    ]);
    await Faucet.waitForDeployment();
    const faucetAddr = await Faucet.getAddress();
    console.log("\nLuminaFaucet deployed to:", faucetAddr);
    console.log("  USDC:", USDC, "drip:", USDC_AMOUNT.toString(), "(=10,000)");
    console.log("  LIT: ", LIT, "drip:", LIT_AMOUNT.toString(), "(=5)");
    console.log("  Cooldown:", COOLDOWN, "seconds");

    // 2. Transfer USDC + LIT ownership to faucet
    const ownableAbi = [
        "function transferOwnership(address newOwner) external",
        "function owner() external view returns (address)",
    ];
    const usdc = await hre.ethers.getContractAt(ownableAbi, USDC, deployer);
    const lit = await hre.ethers.getContractAt(ownableAbi, LIT, deployer);

    console.log("\nTransferring USDC ownership to faucet…");
    let tx = await usdc.transferOwnership(faucetAddr);
    console.log("  tx:", tx.hash);
    await tx.wait();

    console.log("Transferring LIT ownership to faucet…");
    tx = await lit.transferOwnership(faucetAddr);
    console.log("  tx:", tx.hash);
    await tx.wait();

    console.log("\nVerifying owners…");
    console.log("  USDC.owner():", await usdc.owner());
    console.log("  LIT.owner(): ", await lit.owner());

    console.log("\n✓ Faucet ready: " + faucetAddr);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
