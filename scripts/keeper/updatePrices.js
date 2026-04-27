/**
 * Lumina multi-token price keeper.
 *
 * For each configured feed:
 *   1. Fetch current USD price from CoinGecko
 *   2. setAnswer() on the UpdatableAggregator (consumed by AaveOracle)
 *   3. (optional) setPrice() on MockSwapper so testnet leverage swap rates
 *      stay aligned with AaveOracle.
 *
 * Run on Base Sepolia:
 *   npx hardhat run scripts/keeper/updatePrices.js --network baseSepolia
 *
 * Optional env:
 *   COINGECKO_API_KEY    pro key (sent as x-cg-pro-api-key)
 *   FEED_FILTER          comma-separated labels to limit ("LIT,WETH")
 */

const hre = require("hardhat");

const MOCK_SWAPPER = "0x387Ec86135feAbC98F75729F75b9F3EA4e99c114";

const FEEDS = [
    {
        label: "LIT",
        coinId: "lighter",
        feed: "0x1c2af9252306DD4Be3fF79980302C64a7BA46B1d",
        token: "0xDf2B23A45B9a451c002c27F83e9e55da5efdc992",
        decimals: 18,
        // MockSwapper still uses LIT for the testnet leverage path → mirror price.
        syncToSwapper: true,
    },
    {
        label: "WETH",
        coinId: "ethereum",
        feed: "0x9966BCA6eD030256c2585D8823ecF035e296f49A",
        token: "0x4200000000000000000000000000000000000006",
        decimals: 18,
        // WETH not in MockSwapper's swap mix yet — skip mirror.
        syncToSwapper: false,
    },
];

const FEED_ABI = [
    "function setAnswer(int256 newAnswer) external",
    "function latestAnswer() view returns (int256)",
    "function lastUpdatedAt() view returns (uint256)",
];
const SWAPPER_ABI = [
    "function setPrice(address token, uint256 price1e8, uint8 decimals) external",
    "function priceUsd1e8(address token) view returns (uint256)",
];

function priceTo1e8(usd) {
    return BigInt(Math.round(usd * 1e8));
}

async function fetchPrices(coinIds, apiKey) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinIds.join(",")}&vs_currencies=usd`;
    const res = await fetch(url, {
        headers: apiKey ? { "x-cg-pro-api-key": apiKey } : undefined,
    });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    return res.json();
}

async function main() {
    const filter = (process.env.FEED_FILTER || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const targets = filter.length ? FEEDS.filter((f) => filter.includes(f.label)) : FEEDS;

    if (targets.length === 0) {
        console.log("No feeds match FEED_FILTER", filter);
        return;
    }

    const [signer] = await hre.ethers.getSigners();
    console.log("Signer: ", signer.address);
    console.log("Network:", hre.network.name);
    console.log("Feeds:  ", targets.map((f) => f.label).join(", "));

    // 1. Batch CoinGecko fetch
    const coinIds = [...new Set(targets.map((f) => f.coinId))];
    const cgData = await fetchPrices(coinIds, process.env.COINGECKO_API_KEY);

    const swapper = await hre.ethers.getContractAt(SWAPPER_ABI, MOCK_SWAPPER, signer);

    let updated = 0;
    let skipped = 0;

    for (const f of targets) {
        const usd = cgData?.[f.coinId]?.usd;
        if (typeof usd !== "number") {
            console.warn(`\n[${f.label}] no USD price for ${f.coinId} — skipping`);
            skipped++;
            continue;
        }
        const newAnswer = priceTo1e8(usd);
        console.log(`\n[${f.label}]  CG: $${usd.toFixed(6)}  (1e8: ${newAnswer})`);

        // 2. Aggregator
        const feed = await hre.ethers.getContractAt(FEED_ABI, f.feed, signer);
        const prev = await feed.latestAnswer();
        if (prev.toString() === newAnswer.toString()) {
            console.log(`  feed: unchanged (${prev}) — skip`);
        } else {
            const tx = await feed.setAnswer(newAnswer);
            console.log(`  feed: ${prev} → ${newAnswer}  (tx ${tx.hash})`);
            await tx.wait();
            updated++;
        }

        // 3. MockSwapper mirror
        if (f.syncToSwapper) {
            const swapperPrev = await swapper.priceUsd1e8(f.token);
            if (swapperPrev.toString() === newAnswer.toString()) {
                console.log(`  swapper: unchanged — skip`);
            } else {
                const tx = await swapper.setPrice(f.token, newAnswer, f.decimals);
                console.log(`  swapper: ${swapperPrev} → ${newAnswer}  (tx ${tx.hash})`);
                await tx.wait();
                updated++;
            }
        }
    }

    console.log(`\n✓ Done. ${updated} update(s), ${skipped} skip(s).`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
