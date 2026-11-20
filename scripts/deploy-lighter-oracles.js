// Lighter EVM devnet oracle deployment (spec 3.2; S4c decision 1).
//
// Deploys, before the core deploy, the five oracle contracts of the Lighter devnet and records them
// in the deployment manifest (lumina-monorepo `deployments/<env>.json`, loaded and validated with
// the monorepo loader `deployments/index.mjs`):
//   - LighterCorePriceSource  ETH perp, Core market 0, prices WETH   (contracts.ethPriceSource)
//   - FixedPriceSource        $1.00, prices USDC                     (contracts.usdcPriceSource)
//   - LuminaPriceGuard        guardian Safe, keeper bots.keeper      (contracts.priceGuard)
//   - LighterDualOracle       asset USDC / collateral WETH           (contracts.dualOracleUsdcWeth)
//   - LighterDualOracle       asset WETH / collateral USDC           (contracts.dualOracleWethUsdc)
// The core (lumina-core scripts/lighter) and isolated deploys only read these addresses.
//
// Usage (the chain comes from the manifest; the RPC URL from the env var the manifest names):
//   LUMINA_MANIFEST=/path/to/manifest.json LIGHTER_DEVNET_RPC_URL=http://... \
//     npx hardhat run scripts/deploy-lighter-oracles.js --network lighterDevnet
// Optional:
//   LUMINA_MANIFEST_LOADER  path to deployments/index.mjs (default: the monorepo submodule layout,
//                           <monorepo>/contracts/oracle -> <monorepo>/deployments/index.mjs)
//   LUMINA_ALLOW_DIRTY=true deploy from a checkout with uncommitted changes (local iteration only)
//
// Signing: transactions are sent from `manifest.deployer` through the network's accounts. On the
// local harness that is an unlocked anvil account (no key anywhere); the live deploy needs a
// signer for the deployer key (S12).
//
// Guard market 0: the guardian is the Safe from construction, so the deployer never holds guard
// powers. `addMarket(0, ethPriceSource)` is guardian-only and is therefore one Safe transaction,
// executed after this script and before the core deploy (lumina-monorepo harness/deploy).
//
// The guard pins the Aave PoolAddressesProvider (IPriceOracleSentinel.ADDRESSES_PROVIDER), which
// the core deploy creates later: AaveV3SetupBatch is the deployer's next CREATE after this script
// and creates the provider as its first CREATE, so
//   provider = CREATE(CREATE(deployer, nonceAfterThisScript), 1).
// The deployer must send nothing between this script and the core deploy; the core script checks
// the prediction before its first transaction. If the manifest already has a provider (a guard
// redeploy against an existing market) that address is used instead.
//
// Idempotent: a contract whose manifest entry has code is checked against the manifest and reused.
// The manifest is written (validated, atomically) after every deployment.
// Gas: every transaction has an explicit limit, estimate + 25%, capped at the EIP-7825 per-tx cap.

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const { ethers } = hre;

const TX_GAS_CAP = 16_777_216n; // EIP-7825 (Fusaka) per-transaction gas cap, 2^24
const GAS_BUFFER_PERCENT = 25n;
const READ_GAS_STIPEND = 100_000n; // gas forwarded to READ_CORE (LighterCorePriceSource)
const CORE_MARKET_ID = 0; // ETH perp
const USD_PRICE8 = 100_000_000n;
const REPO = "lumina-oracle";

const DUALS = [
  { key: "dualOracleUsdcWeth", asset: "USDC", collateral: "WETH" },
  { key: "dualOracleWethUsdc", asset: "WETH", collateral: "USDC" },
];

function fail(message) {
  throw new Error(`deploy-lighter-oracles: ${message}`);
}

function eq(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

async function loadLoader() {
  const loaderPath =
    process.env.LUMINA_MANIFEST_LOADER || path.resolve(__dirname, "../../../deployments/index.mjs");
  if (!fs.existsSync(loaderPath)) fail(`manifest loader not found at ${loaderPath} (set LUMINA_MANIFEST_LOADER)`);
  return import(pathToFileURL(loaderPath).href);
}

function git(args) {
  return execFileSync("git", args, { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }).trim();
}

function requireCleanCheckout() {
  if (git(["status", "--porcelain"]) === "") return;
  if (process.env.LUMINA_ALLOW_DIRTY === "true") {
    console.log("WARNING: lumina-oracle checkout has uncommitted changes (LUMINA_ALLOW_DIRTY=true)");
    return;
  }
  fail("lumina-oracle checkout has uncommitted changes; commit first (sourceCommits must match the build)");
}

class ManifestFile {
  constructor(loader, file) {
    this.loader = loader;
    this.file = file;
    this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    // Validate the file as it is (template or deployed) through the shared loader.
    this.loader.loadManifest({ env: this.data.environment, path: file, strict: false });
  }

  save() {
    this.loader.validateManifest(this.data, { strict: false });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }
}

async function hasCode(address) {
  if (!address) return false;
  const code = await ethers.provider.getCode(address);
  return code !== "0x";
}

async function boundedGas(estimate) {
  const block = await ethers.provider.getBlock("latest");
  const cap = block.gasLimit < TX_GAS_CAP ? block.gasLimit : TX_GAS_CAP;
  if (estimate > cap) fail(`gas estimate ${estimate} exceeds the per-transaction cap ${cap}`);
  const buffered = estimate + (estimate * GAS_BUFFER_PERCENT) / 100n;
  return buffered > cap ? cap : buffered;
}

async function deploy(deployer, name, args, gasLog) {
  const factory = await ethers.getContractFactory(name, deployer);
  const request = await factory.getDeployTransaction(...args);
  const gasLimit = await boundedGas(await ethers.provider.estimateGas({ ...request, from: deployer.address }));
  const contract = await factory.deploy(...args, { gasLimit });
  const receipt = await contract.deploymentTransaction().wait();
  if (receipt.status !== 1) fail(`${name} deployment reverted (${receipt.hash})`);
  const address = await contract.getAddress();
  gasLog.push({ name, gasLimit, gasUsed: receipt.gasUsed, hash: receipt.hash });
  console.log(`  ${name} ${address} (gas ${receipt.gasUsed} / limit ${gasLimit})`);
  return contract;
}

async function main() {
  const manifestPath = process.env.LUMINA_MANIFEST;
  if (!manifestPath) fail("set LUMINA_MANIFEST to the manifest path");
  const loader = await loadLoader();
  const mf = new ManifestFile(loader, path.resolve(manifestPath));
  const m = mf.data;

  // ---- chain: from the manifest, refused on mismatch
  const network = await ethers.provider.getNetwork();
  if (BigInt(m.chainId) !== network.chainId) {
    fail(`manifest chainId ${m.chainId} != RPC chain ${network.chainId} (network ${hre.network.name})`);
  }
  console.log(`deploy-lighter-oracles: ${m.environment} (chain ${m.chainId}), manifest ${mf.file}`);

  // ---- inputs
  const deployerAddress = m.deployer;
  const safe = m.safe?.address;
  const keeper = m.bots?.keeper;
  if (!safe || !(await hasCode(safe))) fail("safe.address must be set and hold code (create the Safe first)");
  if (!keeper) fail("bots.keeper must be set");
  const WETH = m.assets.WETH.address;
  const USDC = m.assets.USDC.address;
  const symbolOf = (a) => (eq(a, WETH) ? "WETH" : eq(a, USDC) ? "USDC" : null);
  for (const [symbol, a] of [["WETH", WETH], ["USDC", USDC]]) {
    if (!(await hasCode(a))) fail(`no code at assets.${symbol} ${a}`);
  }

  const coreIndex = m.oracle.coreSources.findIndex((s) => eq(s.asset, WETH) && s.marketId === CORE_MARKET_ID);
  if (coreIndex < 0) fail("oracle.coreSources needs the WETH source of Core market 0");
  const core = m.oracle.coreSources[coreIndex];
  for (const f of ["priceDecimals", "minPrice8", "maxPrice8"]) {
    if (core[f] === null || core[f] === undefined) fail(`oracle.coreSources[${coreIndex}].${f} must be set`);
  }
  const fixedIndex = m.oracle.fixedSources.findIndex((s) => eq(s.asset, USDC));
  if (fixedIndex < 0) fail("oracle.fixedSources needs the USDC source");
  const fixed = m.oracle.fixedSources[fixedIndex];
  if (BigInt(fixed.price8) !== USD_PRICE8) fail(`oracle.fixedSources[${fixedIndex}].price8 must be ${USD_PRICE8}`);
  const g = m.oracle.guard;
  if (!g.marketIds.includes(CORE_MARKET_ID)) fail("oracle.guard.marketIds must include 0");
  const dualIndex = {};
  for (const d of DUALS) {
    const i = m.oracle.dualOracles.findIndex((x) => symbolOf(x.asset) === d.asset && symbolOf(x.collateral) === d.collateral);
    if (i < 0) fail(`oracle.dualOracles needs ${d.asset}/${d.collateral}`);
    dualIndex[d.key] = i;
  }

  const deployer = await ethers.getSigner(deployerAddress);
  const gasLog = [];
  const startBlock = await ethers.provider.getBlockNumber();
  let clean = false;
  const ensureClean = () => {
    if (!clean) requireCleanCheckout();
    clean = true;
  };
  const record = async (key, address) => {
    const code = await ethers.provider.getCode(address);
    m.contracts[key].address = address;
    m.contracts[key].codehash = ethers.keccak256(code);
    if (m.deploymentBlock === null) m.deploymentBlock = startBlock + 1;
    m.sourceCommits[REPO] = git(["rev-parse", "HEAD"]);
    mf.save();
  };
  const existing = async (key) => {
    const a = m.contracts[key]?.address;
    return a && (await hasCode(a)) ? a : null;
  };

  // ---- 1. LighterCorePriceSource (ETH perp index, WETH)
  let ethSource = await existing("ethPriceSource");
  if (!ethSource) {
    ensureClean();
    console.log("deploying LighterCorePriceSource (Core market 0)");
    const c = await deploy(
      deployer,
      "LighterCorePriceSource",
      [CORE_MARKET_ID, core.priceDecimals, BigInt(core.minPrice8), BigInt(core.maxPrice8), READ_GAS_STIPEND, "ETH / USD (Lighter Core market 0 index)"],
      gasLog,
    );
    ethSource = await c.getAddress();
    await record("ethPriceSource", ethSource);
  }
  const eth = await ethers.getContractAt("LighterCorePriceSource", ethSource);
  if (
    Number(await eth.MARKET_ID()) !== CORE_MARKET_ID ||
    Number(await eth.PRICE_DECIMALS()) !== core.priceDecimals ||
    (await eth.MIN_PRICE()) !== BigInt(core.minPrice8) ||
    (await eth.MAX_PRICE()) !== BigInt(core.maxPrice8)
  ) {
    fail(`existing LighterCorePriceSource ${ethSource} does not match oracle.coreSources[${coreIndex}]`);
  }
  console.log(`  ETH / USD = ${await eth.latestAnswer()} (8 decimals)`);
  m.oracle.coreSources[coreIndex].address = ethSource;
  mf.save();

  // ---- 2. FixedPriceSource ($1.00, USDC)
  let usdcSource = await existing("usdcPriceSource");
  if (!usdcSource) {
    ensureClean();
    console.log("deploying FixedPriceSource ($1.00)");
    const c = await deploy(deployer, "FixedPriceSource", [USD_PRICE8, "USDC / USD (fixed $1.00)"], gasLog);
    usdcSource = await c.getAddress();
    await record("usdcPriceSource", usdcSource);
  }
  const usd = await ethers.getContractAt("FixedPriceSource", usdcSource);
  if ((await usd.PRICE()) !== USD_PRICE8) fail(`existing FixedPriceSource ${usdcSource} price != ${USD_PRICE8}`);
  m.oracle.fixedSources[fixedIndex].address = usdcSource;
  mf.save();

  // ---- 3. LuminaPriceGuard
  let guardAddress = await existing("priceGuard");
  let predicted = null;
  if (!guardAddress) {
    ensureClean();
    let provider = m.contracts.poolAddressesProvider?.address;
    if (provider && (await hasCode(provider))) {
      console.log(`guard: pinning the existing PoolAddressesProvider ${provider}`);
    } else {
      const remaining = 1 + (await Promise.all(DUALS.map((d) => existing(d.key)))).filter((a) => !a).length;
      const nonceNow = await ethers.provider.getTransactionCount(deployerAddress, "latest");
      const nonceAfter = nonceNow + remaining;
      const setupBatch = ethers.getCreateAddress({ from: deployerAddress, nonce: nonceAfter });
      provider = ethers.getCreateAddress({ from: setupBatch, nonce: 1 });
      predicted = { nonceAfter, provider };
      console.log(`guard: PoolAddressesProvider predicted at ${provider} (deployer nonce ${nonceAfter} after this script)`);
    }
    console.log("deploying LuminaPriceGuard");
    const c = await deploy(
      deployer,
      "LuminaPriceGuard",
      [provider, safe, keeper, g.maxRefAgeSec, g.maxDeviationBps, g.maxCorePriceAgeSec],
      gasLog,
    );
    guardAddress = await c.getAddress();
    await record("priceGuard", guardAddress);
  }
  const guard = await ethers.getContractAt("LuminaPriceGuard", guardAddress);
  if (!eq(await guard.guardian(), safe)) fail(`guard ${guardAddress}: guardian is not the Safe`);
  if (!eq(await guard.pendingGuardian(), ethers.ZeroAddress)) fail(`guard ${guardAddress}: pending guardian set`);
  if (!eq(await guard.keeper(), keeper)) fail(`guard ${guardAddress}: keeper is not bots.keeper`);
  if (
    Number(await guard.maxRefAge()) !== g.maxRefAgeSec ||
    Number(await guard.maxDeviationBps()) !== g.maxDeviationBps ||
    Number(await guard.maxCorePriceAge()) !== g.maxCorePriceAgeSec
  ) {
    fail(`guard ${guardAddress}: parameters differ from oracle.guard`);
  }
  m.roles.guard.guardian = safe;
  m.roles.guard.keeper = keeper;
  mf.save();

  // ---- 4. LighterDualOracle x2
  const sourceOf = { WETH: ethSource, USDC: usdcSource };
  const tokenOf = { WETH, USDC };
  for (const d of DUALS) {
    let address = await existing(d.key);
    if (!address) {
      ensureClean();
      console.log(`deploying LighterDualOracle ${d.asset}/${d.collateral}`);
      const c = await deploy(
        deployer,
        "LighterDualOracle",
        [tokenOf[d.asset], tokenOf[d.collateral], sourceOf[d.asset], sourceOf[d.collateral], guardAddress, `Lighter ${d.asset}/${d.collateral} (Core index)`],
        gasLog,
      );
      address = await c.getAddress();
      await record(d.key, address);
    }
    const o = await ethers.getContractAt("LighterDualOracle", address);
    const wiring = [
      [await o.ASSET(), tokenOf[d.asset]],
      [await o.COLLATERAL(), tokenOf[d.collateral]],
      [await o.ASSET_PRICE_SOURCE(), sourceOf[d.asset]],
      [await o.COLLATERAL_PRICE_SOURCE(), sourceOf[d.collateral]],
      [await o.GUARD(), guardAddress],
    ];
    if (!wiring.every(([a, b]) => eq(a, b))) fail(`dual oracle ${d.key} ${address}: wiring differs`);
    m.oracle.dualOracles[dualIndex[d.key]].address = address;
    mf.save();
  }

  // ---- the guard's provider prediction holds only if nothing else was sent by the deployer
  if (predicted) {
    const nonceNow = await ethers.provider.getTransactionCount(deployerAddress, "latest");
    if (nonceNow !== predicted.nonceAfter) {
      fail(`deployer nonce is ${nonceNow}, the guard assumed ${predicted.nonceAfter}: reset the guard and dual oracles in the manifest and rerun`);
    }
  }
  const provider = await guard.ADDRESSES_PROVIDER();
  console.log(`guard ADDRESSES_PROVIDER = ${provider}`);

  // ---- wiring invariant (plan.md): one LighterCorePriceSource for WETH everywhere it is read
  const [guarded, market0Source] = await guard.getMarket(CORE_MARKET_ID);
  if (guarded && !eq(market0Source, ethSource)) fail(`guard market 0 source ${market0Source} != ${ethSource}`);
  if (!guarded) {
    console.log(`NEXT (Safe ${safe}): guard.addMarket(${CORE_MARKET_ID}, ${ethSource}) before the core deploy`);
  }

  const total = gasLog.reduce((s, x) => s + x.gasUsed, 0n);
  const max = gasLog.reduce((s, x) => (x.gasUsed > s ? x.gasUsed : s), 0n);
  console.log(`deploy-lighter-oracles: OK (${gasLog.length} transaction(s), gas used ${total}, max ${max})`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
