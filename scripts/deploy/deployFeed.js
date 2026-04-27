/**
 * Generic deploy script for an UpdatableAggregator + AaveOracle source switch.
 *
 * Configurable via env (all required unless noted):
 *   TOKEN              ERC20 address whose source we're replacing
 *   COINGECKO_ID       CoinGecko coin id (e.g. "lighter", "ethereum")
 *   DESCRIPTION        feed label, e.g. "WETH / USD (CoinGecko)"
 *   AAVE_ORACLE        (optional, default below) AaveOracle address
 *   MAX_DEVIATION_BPS  (optional, default 5000 = 50%)
 *
 * Usage:
 *   TOKEN=0x4200…0006 COINGECKO_ID=ethereum DESCRIPTION="WETH / USD (CoinGecko)" \
 *     npx hardhat run scripts/deploy/deployFeed.js --network baseSepolia
 *
 * Caller must be Pool/AssetListing admin.
 */

const hre = require("hardhat");

const DEFAULT_AAVE_ORACLE = "0x0103951a20eD2bd84Bd79FE3719553A358893911";
const DEFAULT_MAX_DEVIATION_BPS = 5_000;

const AAVE_ORACLE_ABI = [
    "function setAssetSources(address[] assets, address[] sources) external",
    "function getSourceOfAsset(address asset) view returns (address)",
    "function getAssetPrice(address asset) view returns (uint256)",
];

async function fetchCoingeckoPrice(coinId, apiKey) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
    const res = await fetch(url, {
        headers: apiKey ? { "x-cg-pro-api-key": apiKey } : undefined,
    });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    const usd = data?.[coinId]?.usd;
    if (typeof usd !== "number") throw new Error(`No USD price for ${coinId}`);
    return usd;
}

function priceTo1e8(usd) {
    return BigInt(Math.round(usd * 1e8));
}

async function main() {
    const TOKEN = process.env.TOKEN;
    const COINGECKO_ID = process.env.COINGECKO_ID;
    const DESCRIPTION = process.env.DESCRIPTION;
    const AAVE_ORACLE = process.env.AAVE_ORACLE || DEFAULT_AAVE_ORACLE;
    const MAX_DEVIATION_BPS = process.env.MAX_DEVIATION_BPS
        ? Number(process.env.MAX_DEVIATION_BPS)
        : DEFAULT_MAX_DEVIATION_BPS;

    if (!TOKEN || !COINGECKO_ID || !DESCRIPTION) {
        console.error("Missing required env: TOKEN, COINGECKO_ID, DESCRIPTION");
        process.exit(1);
    }

    const [deployer] = await hre.ethers.getSigners();
    console.log("Deployer:    ", deployer.address);
    console.log("Network:     ", hre.network.name);
    console.log("Token:       ", TOKEN);
    console.log("CoinGecko id:", COINGECKO_ID);

    // 1. Fetch initial price
    console.log("\n[1/4] Fetching price from CoinGecko…");
    const usd = await fetchCoingeckoPrice(COINGECKO_ID, process.env.COINGECKO_API_KEY);
    const priceWei = priceTo1e8(usd);
    console.log(`  → $${usd.toFixed(6)}  (1e8 raw: ${priceWei})`);

    // 2. Deploy aggregator
    console.log("\n[2/4] Deploying UpdatableAggregator…");
    const Feed = await hre.ethers.deployContract("UpdatableAggregator", [
        DESCRIPTION,
        priceWei,
        MAX_DEVIATION_BPS,
    ]);
    await Feed.waitForDeployment();
    const feedAddr = await Feed.getAddress();
    console.log("  → deployed:", feedAddr);

    // 3. Switch AaveOracle source
    console.log("\n[3/4] Switching AaveOracle source…");
    const oracle = await hre.ethers.getContractAt(AAVE_ORACLE_ABI, AAVE_ORACLE, deployer);
    const oldSource = await oracle.getSourceOfAsset(TOKEN);
    console.log("  → old source:", oldSource);
    const tx = await oracle.setAssetSources([TOKEN], [feedAddr]);
    console.log("  → tx:        ", tx.hash);
    await tx.wait();
    const newSource = await oracle.getSourceOfAsset(TOKEN);
    console.log("  → new source:", newSource);

    // 4. Verify on-chain price
    const newPrice = await oracle.getAssetPrice(TOKEN);
    console.log("\n[4/4] AaveOracle.getAssetPrice():", newPrice.toString(), "(expected ~", priceWei.toString() + ")");

    console.log("\n════════════════════════════════════════════════════════════");
    console.log("Feed:", feedAddr);
    console.log("Add to keeper config and frontend ADDRESSES if needed");
    console.log("════════════════════════════════════════════════════════════");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
