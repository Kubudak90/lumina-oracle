/**
 * Lumina LIT price keeper.
 *
 * Fetches LIT/USD from CoinGecko (`lighter`) and pushes the new answer into:
 *   - UpdatableAggregator (consumed by AaveOracle for the lending markets)
 *   - MockSwapper (used by Looping for testnet swaps)
 *
 * Run on Base Sepolia:
 *   npx hardhat run scripts/keeper/updateLitPrice.js --network baseSepolia
 *
 * Configurable via env:
 *   LIT_FEED            override aggregator address
 *   MOCK_SWAPPER        override swapper address
 *   COINGECKO_ID        override coin id (default: lighter)
 *   COINGECKO_API_KEY   optional pro API key (sent as x-cg-pro-api-key)
 *   SKIP_SWAPPER=1      skip MockSwapper sync
 */

const hre = require("hardhat");

const DEFAULTS = {
    LIT_FEED: "0x1c2af9252306DD4Be3fF79980302C64a7BA46B1d",
    MOCK_SWAPPER: "0x387Ec86135feAbC98F75729F75b9F3EA4e99c114",
    LIT_TOKEN: "0xDf2B23A45B9a451c002c27F83e9e55da5efdc992",
    COINGECKO_ID: "lighter",
};

const FEED_ABI = [
    "function setAnswer(int256 newAnswer) external",
    "function latestAnswer() view returns (int256)",
    "function lastUpdatedAt() view returns (uint256)",
];
const SWAPPER_ABI = [
    "function setPrice(address token, uint256 price1e8, uint8 decimals) external",
    "function priceUsd1e8(address token) view returns (uint256)",
];

async function fetchPrice(coinId, apiKey) {
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
    const cfg = {
        feed: process.env.LIT_FEED || DEFAULTS.LIT_FEED,
        swapper: process.env.MOCK_SWAPPER || DEFAULTS.MOCK_SWAPPER,
        litToken: DEFAULTS.LIT_TOKEN,
        coinId: process.env.COINGECKO_ID || DEFAULTS.COINGECKO_ID,
        apiKey: process.env.COINGECKO_API_KEY,
        skipSwapper: process.env.SKIP_SWAPPER === "1",
    };

    const [signer] = await hre.ethers.getSigners();
    console.log("Signer: ", signer.address);
    console.log("Network:", hre.network.name);
    console.log("Coin:   ", cfg.coinId);

    // 1. Fetch
    const usd = await fetchPrice(cfg.coinId, cfg.apiKey);
    const newAnswer = priceTo1e8(usd);
    console.log(`\nFetched ${cfg.coinId}: $${usd.toFixed(6)}  (1e8 raw: ${newAnswer})`);

    // 2. Update UpdatableAggregator
    const feed = await hre.ethers.getContractAt(FEED_ABI, cfg.feed, signer);
    const prev = await feed.latestAnswer();
    const lastTs = await feed.lastUpdatedAt();
    console.log(`\n[feed ${cfg.feed}]`);
    console.log(`  prev: ${prev}  (lastUpdated: ${lastTs})`);
    if (prev.toString() === newAnswer.toString()) {
        console.log("  → unchanged, skipping setAnswer");
    } else {
        const tx = await feed.setAnswer(newAnswer);
        console.log("  → tx:", tx.hash);
        await tx.wait();
        console.log("  → updated:", (await feed.latestAnswer()).toString());
    }

    // 3. Update MockSwapper price (Looping needs swap rate aligned with AaveOracle)
    if (!cfg.skipSwapper) {
        const swapper = await hre.ethers.getContractAt(SWAPPER_ABI, cfg.swapper, signer);
        const swapperPrev = await swapper.priceUsd1e8(cfg.litToken);
        console.log(`\n[swapper ${cfg.swapper}]`);
        console.log(`  prev LIT: ${swapperPrev}`);
        if (swapperPrev.toString() === newAnswer.toString()) {
            console.log("  → unchanged, skipping setPrice");
        } else {
            const tx = await swapper.setPrice(cfg.litToken, newAnswer, 18);
            console.log("  → tx:", tx.hash);
            await tx.wait();
            console.log("  → updated:", (await swapper.priceUsd1e8(cfg.litToken)).toString());
        }
    } else {
        console.log("\n[swapper] skipped (SKIP_SWAPPER=1)");
    }

    console.log("\n✓ Done.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
