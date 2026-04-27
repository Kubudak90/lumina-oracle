const hre = require("hardhat");

const FAUCET = "0x158b2a57C84C9C150b4D9CE5f8b78949145652d0";
const USDC = "0x57d6EB79ea08D10d7e03865cb1820f01F82255c4";
const LIT = "0xDf2B23A45B9a451c002c27F83e9e55da5efdc992";
const LOOPING = "0xaB15f28b4e0821504c67D81E2B0B6468c2ee2429";

// Aave oracle prices (1e8 USD-base)
const USDC_PRICE_1E8 = 100_000000n;          // $1.00
const LIT_PRICE_1E8 = 3500_00000000n;        // $3,500.00 (matches AaveOracle reading)

// Reserve seed amounts
const USDC_RESERVE = 100_000n * 10n ** 6n;   // 100,000 USDC
const LIT_RESERVE = 1_000n * 10n ** 18n;     // 1,000 LIT (≈ $3.5M)

const FAUCET_ABI = [
    "function recoverOwnership(address token, address newOwner) external",
];
const TOKEN_ABI = [
    "function mint(address to, uint256 amount) external",
    "function transferOwnership(address newOwner) external",
    "function balanceOf(address account) view returns (uint256)",
];
const LOOPING_ABI = ["function setSwapper(address swapper, bool isApproved) external"];

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Network: ", hre.network.name);

    // 1. Deploy MockSwapper
    console.log("\n[1/7] Deploying MockSwapper…");
    const Swapper = await hre.ethers.deployContract("MockSwapper");
    await Swapper.waitForDeployment();
    const swapperAddr = await Swapper.getAddress();
    console.log("  → MockSwapper deployed:", swapperAddr);

    // 2. Configure prices
    console.log("\n[2/7] Setting prices…");
    let tx = await Swapper.setPrice(USDC, USDC_PRICE_1E8, 6);
    await tx.wait();
    tx = await Swapper.setPrice(LIT, LIT_PRICE_1E8, 18);
    await tx.wait();
    console.log("  → USDC: $1.00 / LIT: $3500.00");

    // 3. Pull USDC ownership from faucet → seed reserve → restore faucet ownership
    const faucet = await hre.ethers.getContractAt(FAUCET_ABI, FAUCET, deployer);

    console.log("\n[3/7] Reclaiming USDC ownership from faucet…");
    tx = await faucet.recoverOwnership(USDC, deployer.address);
    await tx.wait();

    console.log("[3/7] Minting USDC reserves to swapper…");
    const usdc = await hre.ethers.getContractAt(TOKEN_ABI, USDC, deployer);
    tx = await usdc.mint(swapperAddr, USDC_RESERVE);
    await tx.wait();
    console.log("  → minted", USDC_RESERVE.toString(), "USDC raw");

    console.log("[3/7] Restoring USDC ownership to faucet…");
    tx = await usdc.transferOwnership(FAUCET);
    await tx.wait();

    // 4. Same for LIT
    console.log("\n[4/7] Reclaiming LIT ownership from faucet…");
    tx = await faucet.recoverOwnership(LIT, deployer.address);
    await tx.wait();

    console.log("[4/7] Minting LIT reserves to swapper…");
    const lit = await hre.ethers.getContractAt(TOKEN_ABI, LIT, deployer);
    tx = await lit.mint(swapperAddr, LIT_RESERVE);
    await tx.wait();
    console.log("  → minted", LIT_RESERVE.toString(), "LIT raw");

    console.log("[4/7] Restoring LIT ownership to faucet…");
    tx = await lit.transferOwnership(FAUCET);
    await tx.wait();

    // 5. Whitelist swapper in Looping
    console.log("\n[5/7] Whitelisting swapper in Looping…");
    const looping = await hre.ethers.getContractAt(LOOPING_ABI, LOOPING, deployer);
    tx = await looping.setSwapper(swapperAddr, true);
    await tx.wait();

    // 6. Verify reserves
    console.log("\n[6/7] Verifying reserves…");
    const usdcBal = await usdc.balanceOf(swapperAddr);
    const litBal = await lit.balanceOf(swapperAddr);
    console.log("  → swapper.USDC:", usdcBal.toString());
    console.log("  → swapper.LIT: ", litBal.toString());

    console.log("\n[7/7] Done.");
    console.log("════════════════════════════════════════════════════════════");
    console.log("MockSwapper:", swapperAddr);
    console.log("Add to frontend ADDRESSES.swapper and KNOWN_SWAPPER_CANDIDATES");
    console.log("════════════════════════════════════════════════════════════");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
