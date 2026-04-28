/**
 * Adds WETH to MockSwapper:
 *   1. Sets the WETH price on the swapper (CoinGecko ETH/USD)
 *   2. Wraps SEED_ETH into WETH9 and transfers to the swapper
 *
 *   npx hardhat run scripts/deploy/seedSwapperWeth.js --network baseSepolia
 *
 * Caller must be MockSwapper admin. Defaults: 0.03 ETH seed (~$68 at $2278/ETH).
 */

const hre = require("hardhat");

const MOCK_SWAPPER = "0x387Ec86135feAbC98F75729F75b9F3EA4e99c114";
const WETH = "0x4200000000000000000000000000000000000006";
const SEED_ETH = process.env.SEED_ETH ? BigInt(Math.round(Number(process.env.SEED_ETH) * 1e18)) : 30n * 10n ** 15n; // 0.03 ETH

const SWAPPER_ABI = [
    "function setPrice(address token, uint256 price1e8, uint8 decimals) external",
    "function priceUsd1e8(address token) view returns (uint256)",
];
const WETH_ABI = [
    "function deposit() payable",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
];

async function fetchEthPrice() {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    return data?.ethereum?.usd;
}

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Network: ", hre.network.name);

    // 1. Fetch ETH price
    const usd = await fetchEthPrice();
    if (typeof usd !== "number") throw new Error("CoinGecko returned no ETH price");
    const priceWei = BigInt(Math.round(usd * 1e8));
    console.log(`\n[1/4] ETH price: $${usd.toFixed(2)}  (1e8 raw: ${priceWei})`);

    // 2. Set MockSwapper price for WETH
    console.log("\n[2/4] Setting MockSwapper.priceUsd1e8(WETH)…");
    const swapper = await hre.ethers.getContractAt(SWAPPER_ABI, MOCK_SWAPPER, deployer);
    let tx = await swapper.setPrice(WETH, priceWei, 18);
    console.log("  tx:", tx.hash);
    await tx.wait();
    const newPrice = await swapper.priceUsd1e8(WETH);
    console.log("  swapper now:", newPrice);

    // 3. Wrap ETH → WETH
    console.log(`\n[3/4] Wrapping ${Number(SEED_ETH) / 1e18} ETH to WETH9…`);
    const weth = await hre.ethers.getContractAt(WETH_ABI, WETH, deployer);
    tx = await weth.deposit({ value: SEED_ETH });
    console.log("  tx:", tx.hash);
    await tx.wait();
    const myWeth = await weth.balanceOf(deployer.address);
    console.log("  deployer WETH:", myWeth);

    // 4. Transfer WETH to swapper
    console.log("\n[4/4] Transferring WETH to swapper…");
    tx = await weth.transfer(MOCK_SWAPPER, SEED_ETH);
    console.log("  tx:", tx.hash);
    await tx.wait();
    const swapperWeth = await weth.balanceOf(MOCK_SWAPPER);
    console.log("  swapper WETH balance:", swapperWeth);

    console.log("\n════════════════════════════════════════════════════════════");
    console.log(`✓ Swapper now holds ${Number(swapperWeth) / 1e18} WETH and prices it at $${usd.toFixed(2)}`);
    console.log("Update updatePrices.js → set WETH syncToSwapper: true");
    console.log("════════════════════════════════════════════════════════════");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
