const hre = require("hardhat");

const { verify } = require("./utils/verify");

// =============================================================================
// LighterEVM Oracle Infrastructure Deployment Script
// =============================================================================
// Deploys the complete oracle stack for LighterEVM (chainId 999):
//   1. Aggregator            - main price oracle aggregator
//   2. StaticOracle (USDC)   - returns fixed 1 USD price for stablecoin
//   3. PythOracleAdapter     - Pyth price feed for WETH
//   4. AssetOracleAdapter    - chainlink-compatible proxies on top of Aggregator
//   5. DualFallbackOracle    - resilient wrapper with primary/fallback/emergency
//
// Usage:
//   npx hardhat run scripts/deploy-lighter.js --network lighterEvm
// =============================================================================

// ---------------------------------------------------------------------------
// TODO: Replace placeholder addresses before mainnet deployment
// ---------------------------------------------------------------------------

// TODO: Set the correct Pyth contract address on LighterEVM
const PYTH_CONTRACT = "0x2880aB155794e7179c9eE2e38200202908C17B43";

// TODO: Set the LightLend ACL Manager address (required for DualFallbackOracle admin checks)
const ACL_MANAGER = "0x0000000000000000000000000000000000000000";

// TODO: Set the final owner address (ownership will be transferred at the end)
const FINAL_OWNER = "0x0000000000000000000000000000000000000000";

// TODO: Set the keeper address that will submit round data for non-perp assets
const KEEPER_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Asset Configuration
// ---------------------------------------------------------------------------
const assets = {
    USDC: {
        // TODO: Set the correct USDC token address on LighterEVM
        tokenAddress: "0x0000000000000000000000000000000000000000",
        // USDC uses the Aggregator with keeper-submitted EMA prices.
        // A StaticOracle is deployed as a standalone fallback that always returns $1.
        // For the Aggregator entry we use a high metaIndex (not a real perp index).
        isPerpOracle: false,
        metaIndex: 200,       // arbitrary unused index for non-perp asset
        metaDecimals: 0,
        initialPrice: 100000000, // 1e8 = $1.00 (8 decimals)
        oracleName: "USDC/USD",
        oracleDecimals: 8,
    },
    WETH: {
        // TODO: Set the correct WETH token address on LighterEVM
        tokenAddress: "0x0000000000000000000000000000000000000000",
        // TODO: Set the correct Pyth price feed ID for ETH/USD on LighterEVM
        pythPriceFeedId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
        // WETH uses the Aggregator with perp oracle if available, otherwise keeper EMA.
        // A PythOracleAdapter is deployed as a standalone oracle source.
        isPerpOracle: true,
        metaIndex: 4,         // TODO: confirm ETH metaIndex in Hyperliquid SystemOracle meta
        metaDecimals: 4,      // TODO: confirm ETH metaDecimals
        initialPrice: 0,      // perp oracle reads from SystemOracle, no initial price needed
        oracleName: "WETH/USD",
        oracleDecimals: 8,
    },
};

// DualFallbackOracle heartbeat configuration (in seconds)
const MAX_INTERVAL_PRIMARY = 3600;    // 1 hour
const MAX_INTERVAL_FALLBACK = 25200;  // 7 hours

// ---------------------------------------------------------------------------
// Pre-flight validation
// ---------------------------------------------------------------------------
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = "0x" + "0".repeat(64);

// Refuses to run while required config still holds placeholder values, so the
// stack can't be silently deployed with 0x0 wired into immutable constructors.
// FINAL_OWNER and KEEPER_ADDRESS stay optional: main() skips those steps with
// an explicit warning when unset, and both can be configured post-deploy.
function assertConfigured() {
    const placeholders = [];
    if (PYTH_CONTRACT === ZERO_ADDRESS) placeholders.push("PYTH_CONTRACT");
    if (ACL_MANAGER === ZERO_ADDRESS) placeholders.push("ACL_MANAGER");
    for (const [symbol, config] of Object.entries(assets)) {
        if (config.tokenAddress === ZERO_ADDRESS) placeholders.push(`assets.${symbol}.tokenAddress`);
        if (config.isPerpOracle && (!config.pythPriceFeedId || config.pythPriceFeedId === ZERO_BYTES32)) {
            placeholders.push(`assets.${symbol}.pythPriceFeedId`);
        }
    }
    if (placeholders.length > 0) {
        throw new Error(
            `Refusing to deploy: placeholder values still set for ${placeholders.join(", ")}. ` +
            "Fill in the TODO constants at the top of scripts/deploy-lighter.js first."
        );
    }
}

// Gas overrides for LighterEVM
const txOverrides = { gasPrice: 5000000000, gasLimit: 2000000 };

// =============================================================================
// Deployment Steps
// =============================================================================

async function deployAggregator() {
    console.log("\n[1/6] Deploying Aggregator...");
    const aggregator = await hre.ethers.deployContract("Aggregator", [], txOverrides);
    await aggregator.waitForDeployment();
    console.log(`  Aggregator deployed to: ${aggregator.target}`);
    await verify(aggregator.target, []);
    return aggregator;
}

async function deployStaticOracle() {
    console.log("\n[2/6] Deploying StaticOracle (USDC fallback - always $1)...");
    const staticOracle = await hre.ethers.deployContract("StaticOracle", [], txOverrides);
    await staticOracle.waitForDeployment();
    console.log(`  StaticOracle deployed to: ${staticOracle.target}`);
    await verify(staticOracle.target, []);
    return staticOracle;
}

async function deployPythAdapter(asset) {
    console.log("\n[3/6] Deploying PythOracleAdapter (WETH)...");
    const constructorArgs = [
        PYTH_CONTRACT,
        `Pyth-${asset.oracleName}`,
        asset.tokenAddress,
        asset.pythPriceFeedId,
    ];
    const pythAdapter = await hre.ethers.deployContract(
        "PythOracleAdapter",
        constructorArgs,
        txOverrides
    );
    await pythAdapter.waitForDeployment();
    console.log(`  PythOracleAdapter deployed to: ${pythAdapter.target}`);
    await verify(pythAdapter.target, constructorArgs);
    return pythAdapter;
}

async function setupAggregatorAssets(aggregator) {
    console.log("\n[4/6] Configuring assets in Aggregator...");

    for (const [symbol, config] of Object.entries(assets)) {
        console.log(`  Adding ${symbol} (${config.tokenAddress})...`);
        const tx = await aggregator.setAsset(
            config.tokenAddress,
            config.isPerpOracle,
            config.metaIndex,
            config.metaDecimals,
            config.initialPrice,
            false // isUpdate = false (new asset)
        );
        await tx.wait();

        // For perp oracle assets the price comes from SystemOracle; for non-perp
        // assets the initial price we set here will be used until keepers submit updates.
        if (!config.isPerpOracle) {
            const price = await aggregator.getPrice(config.tokenAddress);
            console.log(`  ${symbol} initial price: ${price} (${Number(price) / 1e8} USD)`);
        } else {
            console.log(`  ${symbol} configured as perp-oracle asset (metaIndex=${config.metaIndex})`);
        }
    }
}

async function deployAssetOracleAdapters(aggregator) {
    console.log("\n[5/6] Deploying AssetOracleAdapter proxies...");
    const adapters = {};

    for (const [symbol, config] of Object.entries(assets)) {
        const constructorArgs = [
            aggregator.target,
            config.oracleName,
            config.oracleDecimals,
            config.tokenAddress,
        ];
        const adapter = await hre.ethers.deployContract(
            "AssetOracleAdapter",
            constructorArgs,
            txOverrides
        );
        await adapter.waitForDeployment();
        console.log(`  AssetOracleAdapter (${symbol}) deployed to: ${adapter.target}`);
        await verify(adapter.target, constructorArgs);

        adapters[symbol] = adapter;
    }

    return adapters;
}

async function deployDualFallbackOracle(primaryAddress, fallbackAddress, emergencyAddress, description) {
    console.log("\n[6/6] Deploying DualFallbackOracle...");

    const constructorArgs = [
        primaryAddress,
        fallbackAddress,
        emergencyAddress,
        ACL_MANAGER,
        description,
        MAX_INTERVAL_PRIMARY,
        MAX_INTERVAL_FALLBACK,
    ];
    const dualOracle = await hre.ethers.deployContract(
        "DualFallbackOracle",
        constructorArgs,
        txOverrides
    );
    await dualOracle.waitForDeployment();
    console.log(`  DualFallbackOracle deployed to: ${dualOracle.target}`);
    await verify(dualOracle.target, constructorArgs);
    return dualOracle;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    assertConfigured();

    const [deployer] = await hre.ethers.getSigners();
    console.log("=".repeat(70));
    console.log("LighterEVM Oracle Infrastructure Deployment");
    console.log("=".repeat(70));
    console.log(`Network:  ${hre.network.name} (chainId ${hre.network.config.chainId})`);
    console.log(`Deployer: ${deployer.address}`);
    console.log("=".repeat(70));

    // --- Step 1: Aggregator ---
    const aggregator = await deployAggregator();

    // --- Step 2: StaticOracle (USDC stablecoin fallback) ---
    const staticOracle = await deployStaticOracle();

    // --- Step 3: PythOracleAdapter (WETH) ---
    const pythAdapterWETH = await deployPythAdapter(assets.WETH);

    // --- Step 4: Register assets in Aggregator ---
    await setupAggregatorAssets(aggregator);

    // --- Step 5: AssetOracleAdapter proxies (Chainlink-compatible interface on Aggregator) ---
    const assetAdapters = await deployAssetOracleAdapters(aggregator);

    // --- Step 6: DualFallbackOracle for WETH (primary=AssetOracleAdapter, fallback=Pyth, emergency=Static) ---
    // This gives WETH price resilience: if the Aggregator-based price goes stale,
    // the Pyth adapter kicks in. In an emergency the static oracle can be toggled on.
    const dualOracleWETH = await deployDualFallbackOracle(
        assetAdapters.WETH.target,   // primary:   Aggregator-based adapter
        pythAdapterWETH.target,      // fallback:  Pyth price feed
        staticOracle.target,         // emergency: static oracle (manual toggle)
        "WETH-prim:aggregator-sec:pyth-emerg:static"
    );

    // --- Step 7: Add keeper (if configured) ---
    if (KEEPER_ADDRESS !== "0x0000000000000000000000000000000000000000") {
        console.log(`\n[+] Adding keeper: ${KEEPER_ADDRESS}`);
        const tx = await aggregator.toggleKeeper(KEEPER_ADDRESS);
        await tx.wait();
        console.log("  Keeper added successfully.");
    } else {
        console.log("\n[!] Keeper address not set. Remember to call aggregator.toggleKeeper() later.");
    }

    // --- Step 8: Transfer ownership (if configured) ---
    if (FINAL_OWNER !== "0x0000000000000000000000000000000000000000") {
        console.log(`\n[+] Transferring Aggregator ownership to: ${FINAL_OWNER}`);
        const tx = await aggregator.transferOwnership(FINAL_OWNER);
        await tx.wait();
        console.log("  Ownership transferred.");
    } else {
        console.log("\n[!] Final owner not set. Aggregator ownership remains with deployer.");
    }

    // --- Summary ---
    console.log("\n" + "=".repeat(70));
    console.log("Deployment Summary");
    console.log("=".repeat(70));
    console.log(`Aggregator:                ${aggregator.target}`);
    console.log(`StaticOracle (USDC $1):    ${staticOracle.target}`);
    console.log(`PythOracleAdapter (WETH):  ${pythAdapterWETH.target}`);
    console.log(`AssetOracleAdapter (USDC): ${assetAdapters.USDC.target}`);
    console.log(`AssetOracleAdapter (WETH): ${assetAdapters.WETH.target}`);
    console.log(`DualFallbackOracle (WETH): ${dualOracleWETH.target}`);
    console.log("=".repeat(70));
    console.log("\nTODOs before production:");
    console.log("  - Verify Pyth contract address and ETH/USD price feed ID");
    console.log("  - Set FINAL_OWNER to the governance/multisig address");
    console.log("  - Set KEEPER_ADDRESS to the off-chain keeper bot");
    console.log("  - Confirm metaIndex and metaDecimals for WETH in SystemOracle");
    console.log("  - Deploy additional DualFallbackOracle for USDC if needed");
    console.log("=".repeat(70));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
