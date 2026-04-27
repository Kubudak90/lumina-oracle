/**
 * Deploys an UpdatableAggregator for LIT, fetches the current price from
 * CoinGecko, pushes it on-chain, and points AaveOracle to the new feed.
 *
 * Run on Base Sepolia:
 *   npx hardhat run scripts/deploy/deployLitFeed.js --network baseSepolia
 *
 * Caller must be Pool/AssetListing admin on the AaveOracle's ACL.
 */

const hre = require("hardhat");

const AAVE_ORACLE = "0x0103951a20eD2bd84Bd79FE3719553A358893911";
const LIT = "0xDf2B23A45B9a451c002c27F83e9e55da5efdc992";
const COINGECKO_ID = "lighter";
const MAX_DEVIATION_BPS = 5_000; // allow up to 50% per update on testnet

const AAVE_ORACLE_ABI = [
    "function setAssetSources(address[] assets, address[] sources) external",
    "function getSourceOfAsset(address asset) view returns (address)",
    "function getAssetPrice(address asset) view returns (uint256)",
];

async function fetchCoingeckoPrice() {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_ID}&vs_currencies=usd`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    const usd = data?.[COINGECKO_ID]?.usd;
    if (typeof usd !== "number") throw new Error(`No USD price for ${COINGECKO_ID}`);
    return usd;
}

function priceTo1e8(usd) {
    // 8 decimals — round to nearest cent precision (1e8 base) using bigint to avoid float loss
    const cents1e8 = Math.round(usd * 1e8);
    return BigInt(cents1e8);
}

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deployer:", deployer.address);

    // 1. Fetch initial price from CoinGecko
    console.log("\n[1/4] Fetching LIT price from CoinGecko…");
    const usd = await fetchCoingeckoPrice();
    const priceWei = priceTo1e8(usd);
    console.log("  → $" + usd.toFixed(6), "  (1e8 raw:", priceWei.toString() + ")");

    // 2. Deploy UpdatableAggregator with initial price
    console.log("\n[2/4] Deploying UpdatableAggregator…");
    const Feed = await hre.ethers.deployContract("UpdatableAggregator", [
        "LIT / USD (CoinGecko)",
        priceWei,
        MAX_DEVIATION_BPS,
    ]);
    await Feed.waitForDeployment();
    const feedAddr = await Feed.getAddress();
    console.log("  → deployed:", feedAddr);

    // 3. Switch AaveOracle source for LIT
    console.log("\n[3/4] Switching AaveOracle LIT source…");
    const oracle = await hre.ethers.getContractAt(AAVE_ORACLE_ABI, AAVE_ORACLE, deployer);
    const oldSource = await oracle.getSourceOfAsset(LIT);
    console.log("  → old source:", oldSource);
    let tx = await oracle.setAssetSources([LIT], [feedAddr]);
    console.log("  → tx:", tx.hash);
    await tx.wait();
    const newSource = await oracle.getSourceOfAsset(LIT);
    console.log("  → new source:", newSource);

    // 4. Verify on-chain price
    const newPrice = await oracle.getAssetPrice(LIT);
    console.log("\n[4/4] AaveOracle.getAssetPrice(LIT):", newPrice.toString(), "(expected ~", priceWei.toString() + ")");

    console.log("\n════════════════════════════════════════════════════════════");
    console.log("LIT feed:", feedAddr);
    console.log("Add to frontend ADDRESSES.litOracleFeed");
    console.log("Run scripts/keeper/updateLitPrice.js to push fresh prices");
    console.log("════════════════════════════════════════════════════════════");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
