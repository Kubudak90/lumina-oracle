// Lighter EVM devnet oracle deployment (spec 3.2; plan.md S4c decisions, deploy order).
//
// Deploys the oracle contracts of the Lighter devnet in two phases and records them in the
// deployment manifest (lumina-monorepo `deployments/<env>.json`, loaded and validated with the
// monorepo loader `deployments/index.mjs`):
//
//   LUMINA_ORACLE_PHASE=sources (before the core market)
//     - LighterCorePriceSource  ETH perp, Core market 0, prices WETH   (contracts.ethPriceSource)
//     - FixedPriceSource        $1.00, prices USDC                     (contracts.usdcPriceSource)
//   LUMINA_ORACLE_PHASE=guard (after lumina-core deployMarket(): the PoolAddressesProvider exists)
//     - LuminaPriceGuard        the manifest's PoolAddressesProvider, guardian Safe, keeper
//                               bots.keeper, bounds from oracle.guard   (contracts.priceGuard)
//     - LighterDualOracle       asset USDC / collateral WETH           (contracts.dualOracleUsdcWeth)
//     - LighterDualOracle       asset WETH / collateral USDC           (contracts.dualOracleWethUsdc)
// The core (lumina-core scripts/lighter) and isolated deploys only read these addresses. No address
// is predicted: the guard is built against the provider the core deploy recorded and verified.
//
// Usage (the chain comes from the manifest; the RPC URL from the env var the manifest names):
//   LUMINA_ORACLE_PHASE=sources LUMINA_MANIFEST=/path/to/manifest.json LIGHTER_DEVNET_RPC_URL=... \
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
// powers. `addMarket(0, ethPriceSource)` is guardian-only: one Safe transaction after phase
// "guard" (lumina-monorepo harness/deploy).
//
// Crash recovery: before each deployment a write-ahead record goes into the deploy checkpoint
// (LUMINA_DEPLOY_CHECKPOINT): commit, deployer nonce, init code hash, expected address. A run that
// stopped between the transaction and the manifest write is adopted by the next run (or stopped
// with a report if anything differs), never deployed twice.
// Idempotent: a contract whose manifest entry has code is checked against the manifest and reused;
// a phase that deploys nothing leaves sourceCommits as recorded. A phase that deploys continues
// only from the lumina-oracle commit the manifest records (or records HEAD when none is). Every
// deployment is checked on-chain (receipt status, code, codehash) before the manifest is written
// (validated, atomically).
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
const PHASES = ["sources", "guard"];

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
  return (await ethers.provider.getCode(address)) !== "0x";
}

async function boundedGas(estimate) {
  const block = await ethers.provider.getBlock("latest");
  const cap = block.gasLimit < TX_GAS_CAP ? block.gasLimit : TX_GAS_CAP;
  if (estimate > cap) fail(`gas estimate ${estimate} exceeds the per-transaction cap ${cap}`);
  const buffered = estimate + (estimate * GAS_BUFFER_PERCENT) / 100n;
  return buffered > cap ? cap : buffered;
}

const CHECKPOINT = () => {
  const file = process.env.LUMINA_DEPLOY_CHECKPOINT;
  if (!file) fail("set LUMINA_DEPLOY_CHECKPOINT to the deploy checkpoint path (write-ahead records)");
  return path.resolve(file);
};

function readCheckpoint() {
  const file = CHECKPOINT();
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function writeCheckpoint(data) {
  const file = CHECKPOINT();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * A deployment that was sent but never recorded (the run stopped between the transaction and the
 * manifest write). Adopted only if the deployer's transaction at the recorded nonce is exactly the
 * planned creation (same init code hash, successful, at the expected address, with code) and the
 * deployer sent nothing else; otherwise the run stops with a recovery report. Nothing mined: the
 * record is dropped and the contract is deployed normally.
 */
async function resolvePending(m, adopt) {
  const cp = readCheckpoint();
  const p = cp.pending;
  if (!p) return;
  if (p.kind !== "oracle") fail(`the deploy checkpoint has a pending ${p.kind} phase (${p.phase}); resolve it with the harness glue first`);
  const report = (why) => fail(`recovery of "${p.phase}" stopped: ${why}. Pending record: ${JSON.stringify(p)}`);
  const head = git(["rev-parse", "HEAD"]);
  if (head !== p.commit) report(`lumina-oracle HEAD ${head} is not the commit ${p.commit} that sent it`);
  if (!eq(p.deployer, m.deployer)) report("the deployer differs from the manifest");
  for (let i = 0; i < 60; i++) {
    const [latest, pending] = await Promise.all([
      ethers.provider.getTransactionCount(p.deployer, "latest"),
      ethers.provider.getTransactionCount(p.deployer, "pending"),
    ]);
    if (latest === pending) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const nonce = await ethers.provider.getTransactionCount(p.deployer, "latest");
  if (nonce === p.startNonce) {
    console.log(`recovery: "${p.phase}" was never mined; record dropped`);
    delete cp.pending;
    writeCheckpoint(cp);
    return;
  }
  if (nonce !== p.startNonce + 1) report(`the deployer sent ${nonce - p.startNonce} transaction(s) from nonce ${p.startNonce}, the record planned 1`);
  let tx = null;
  const head2 = await ethers.provider.getBlockNumber();
  for (let n = p.startBlock; n <= head2 && !tx; n++) {
    const block = await ethers.provider.getBlock(n, true);
    tx = block.prefetchedTransactions.find((t) => eq(t.from, p.deployer) && t.nonce === p.startNonce) ?? null;
  }
  if (!tx) report(`no transaction of the deployer at nonce ${p.startNonce} since block ${p.startBlock}`);
  const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
  if (receipt.status !== 1) report(`transaction ${tx.hash} at the planned nonce reverted`);
  if (tx.to !== null || ethers.keccak256(tx.data) !== p.plan[0].dataHash) report(`transaction ${tx.hash} is not the planned ${p.name} creation`);
  if (!eq(receipt.contractAddress, p.creates[0])) report(`${tx.hash} created ${receipt.contractAddress}, expected ${p.creates[0]}`);
  const code = await ethers.provider.getCode(p.creates[0]);
  if (code === "0x") report(`no code at ${p.creates[0]}`);
  if (m.contracts[p.key].address) report(`contracts.${p.key} is already set (${m.contracts[p.key].address})`);
  console.log(`recovery: adopted ${p.name} ${p.creates[0]} from ${tx.hash} (block ${receipt.blockNumber})`);
  adopt(p.key, p.creates[0], code, receipt.blockNumber);
}

async function main() {
  const phase = process.env.LUMINA_ORACLE_PHASE;
  if (!PHASES.includes(phase)) fail(`set LUMINA_ORACLE_PHASE to one of ${PHASES.join(", ")}`);
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
  console.log(`deploy-lighter-oracles (${phase}): ${m.environment} (chain ${m.chainId}), manifest ${mf.file}`);

  // ---- inputs
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
  if (BigInt(m.oracle.fixedSources[fixedIndex].price8) !== USD_PRICE8) fail(`oracle.fixedSources[${fixedIndex}].price8 must be ${USD_PRICE8}`);
  const g = m.oracle.guard;
  if (!g.marketIds.includes(CORE_MARKET_ID)) fail("oracle.guard.marketIds must include 0");
  const dualIndex = {};
  for (const d of DUALS) {
    const i = m.oracle.dualOracles.findIndex((x) => symbolOf(x.asset) === d.asset && symbolOf(x.collateral) === d.collateral);
    if (i < 0) fail(`oracle.dualOracles needs ${d.asset}/${d.collateral}`);
    dualIndex[d.key] = i;
  }

  const deployer = await ethers.getSigner(m.deployer);
  const gasLog = [];
  const startBlock = await ethers.provider.getBlockNumber();

  // A deployment continues only from a clean checkout at the commit that started it.
  let checked = false;
  const beforeDeploy = () => {
    if (checked) return;
    if (git(["status", "--porcelain"]) !== "") {
      if (process.env.LUMINA_ALLOW_DIRTY === "true") console.log("WARNING: lumina-oracle checkout has uncommitted changes (LUMINA_ALLOW_DIRTY=true)");
      else fail("lumina-oracle checkout has uncommitted changes; commit first (sourceCommits must match the build)");
    }
    const head = git(["rev-parse", "HEAD"]);
    const recorded = m.sourceCommits[REPO];
    if (recorded && recorded !== head) {
      fail(`lumina-oracle HEAD ${head} differs from the manifest sourceCommits ${recorded}: continue a partial deploy from the commit that started it`);
    }
    checked = true;
  };

  // Write-ahead record (deploy checkpoint, `pending`): written before every deployment, cleared
  // once the manifest holds the verified result. A run that stopped in between is recovered at the
  // start of the next run (resolvePending), never deployed twice.
  const recordAhead = (key, name, deployData, nonce, expected) => {
    writeCheckpoint({
      ...readCheckpoint(),
      pending: {
        kind: "oracle",
        phase: `oracle ${phase}: ${key}`,
        oraclePhase: phase,
        key,
        name,
        repo: REPO,
        commit: git(["rev-parse", "HEAD"]),
        deployer: m.deployer,
        startNonce: nonce,
        startBlock: startBlock,
        plan: [{ nonce, to: null, dataHash: ethers.keccak256(deployData) }],
        creates: [expected],
      },
    });
  };
  const adopt = (key, address, code, minedIn) => {
    m.contracts[key].address = address;
    m.contracts[key].codehash = ethers.keccak256(code);
    if (m.deploymentBlock === null) m.deploymentBlock = minedIn;
    if (!m.sourceCommits[REPO]) m.sourceCommits[REPO] = git(["rev-parse", "HEAD"]);
    mf.save();
    const cp = readCheckpoint();
    delete cp.pending;
    writeCheckpoint(cp);
  };

  const deploy = async (key, name, args) => {
    beforeDeploy();
    console.log(`deploying ${name}`);
    const factory = await ethers.getContractFactory(name, deployer);
    const request = await factory.getDeployTransaction(...args);
    const gasLimit = await boundedGas(await ethers.provider.estimateGas({ ...request, from: deployer.address }));
    const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
    const expected = ethers.getCreateAddress({ from: deployer.address, nonce });
    recordAhead(key, name, request.data, nonce, expected);
    const contract = await factory.deploy(...args, { gasLimit, nonce });
    const receipt = await contract.deploymentTransaction().wait();
    if (receipt.status !== 1) fail(`${name} deployment reverted (${receipt.hash})`);
    if (process.env.LUMINA_TEST_CRASH_AFTER_MINED === "true") {
      console.error(`TEST: simulated crash after ${name} was mined (${receipt.hash}), before the manifest write`);
      process.exit(3);
    }
    const address = await contract.getAddress();
    if (!eq(receipt.contractAddress, address) || !eq(address, expected)) fail(`${name}: deployed at ${receipt.contractAddress}, expected ${expected}`);
    const code = await ethers.provider.getCode(address);
    if (code === "0x") fail(`${name}: no code at ${address}`);
    gasLog.push({ name, gasLimit, gasUsed: receipt.gasUsed, hash: receipt.hash });
    console.log(`  ${name} ${address} (tx ${receipt.hash}, gas ${receipt.gasUsed} / limit ${gasLimit})`);
    // Checkpoint: verified on-chain, then written; the write-ahead record is cleared.
    adopt(key, address, code, receipt.blockNumber);
    return address;
  };
  const existing = async (key) => {
    const entry = m.contracts[key];
    if (!entry?.address || !(await hasCode(entry.address))) return null;
    const hash = ethers.keccak256(await ethers.provider.getCode(entry.address));
    if (hash !== entry.codehash) fail(`contracts.${key} ${entry.address}: codehash ${hash} != manifest ${entry.codehash}`);
    return entry.address;
  };

  await resolvePending(m, adopt);

  // ======================================================================== phase "sources"
  let ethSource = await existing("ethPriceSource");
  let usdcSource = await existing("usdcPriceSource");
  if (phase === "sources") {
    if (!ethSource) {
      ethSource = await deploy("ethPriceSource", "LighterCorePriceSource", [
        CORE_MARKET_ID,
        core.priceDecimals,
        BigInt(core.minPrice8),
        BigInt(core.maxPrice8),
        READ_GAS_STIPEND,
        "ETH / USD (Lighter Core market 0 index)",
      ]);
    }
    if (!usdcSource) {
      usdcSource = await deploy("usdcPriceSource", "FixedPriceSource", [USD_PRICE8, "USDC / USD (fixed $1.00)"]);
    }
  }
  if (!ethSource || !usdcSource) fail('the price sources are not deployed (run phase "sources" first)');
  const eth = await ethers.getContractAt("LighterCorePriceSource", ethSource);
  if (
    Number(await eth.MARKET_ID()) !== CORE_MARKET_ID ||
    Number(await eth.PRICE_DECIMALS()) !== core.priceDecimals ||
    (await eth.MIN_PRICE()) !== BigInt(core.minPrice8) ||
    (await eth.MAX_PRICE()) !== BigInt(core.maxPrice8)
  ) {
    fail(`LighterCorePriceSource ${ethSource} does not match oracle.coreSources[${coreIndex}]`);
  }
  console.log(`  ETH / USD = ${await eth.latestAnswer()} (8 decimals)`);
  const usd = await ethers.getContractAt("FixedPriceSource", usdcSource);
  if ((await usd.PRICE()) !== USD_PRICE8) fail(`FixedPriceSource ${usdcSource} price != ${USD_PRICE8}`);
  m.oracle.coreSources[coreIndex].address = ethSource;
  m.oracle.fixedSources[fixedIndex].address = usdcSource;
  mf.save();

  // ======================================================================== phase "guard"
  if (phase === "guard") {
    // The core market exists and is the manifest's: provider code and codehash, its price oracle,
    // and the AaveOracle sources set to the phase-1 sources.
    const providerAddress = await existing("poolAddressesProvider");
    const oracleAddress = await existing("aaveOracle");
    if (!providerAddress || !oracleAddress) fail("the core market is not deployed (run lumina-core deployMarket() first)");
    const provider = new ethers.Contract(providerAddress, ["function getPriceOracle() view returns (address)"], ethers.provider);
    if (!eq(await provider.getPriceOracle(), oracleAddress)) fail("PoolAddressesProvider.getPriceOracle() is not contracts.aaveOracle");
    const aaveOracle = new ethers.Contract(oracleAddress, ["function getSourceOfAsset(address) view returns (address)"], ethers.provider);
    if (!eq(await aaveOracle.getSourceOfAsset(WETH), ethSource) || !eq(await aaveOracle.getSourceOfAsset(USDC), usdcSource)) {
      fail("AaveOracle sources are not the manifest price sources (run lumina-core deployMarket())");
    }

    let guardAddress = await existing("priceGuard");
    if (!guardAddress) {
      guardAddress = await deploy("priceGuard", "LuminaPriceGuard", [
        providerAddress,
        safe,
        keeper,
        g.maxRefAgeSec,
        g.maxDeviationBps,
        g.maxCorePriceAgeSec,
      ]);
    }
    const guard = await ethers.getContractAt("LuminaPriceGuard", guardAddress);
    if (!eq(await guard.ADDRESSES_PROVIDER(), providerAddress)) fail(`guard ${guardAddress}: ADDRESSES_PROVIDER is not the manifest provider`);
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

    const sourceOf = { WETH: ethSource, USDC: usdcSource };
    const tokenOf = { WETH, USDC };
    for (const d of DUALS) {
      let address = await existing(d.key);
      if (!address) {
        address = await deploy(d.key, "LighterDualOracle", [
          tokenOf[d.asset],
          tokenOf[d.collateral],
          sourceOf[d.asset],
          sourceOf[d.collateral],
          guardAddress,
          `Lighter ${d.asset}/${d.collateral} (Core index)`,
        ]);
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

    // Wiring invariant (plan.md): one LighterCorePriceSource for WETH wherever it is read.
    const [guarded, market0Source] = await guard.getMarket(CORE_MARKET_ID);
    if (guarded && !eq(market0Source, ethSource)) fail(`guard market 0 source ${market0Source} != ${ethSource}`);
    if (!guarded) console.log(`NEXT (Safe ${safe}): guard.addMarket(${CORE_MARKET_ID}, ${ethSource})`);
  }

  const total = gasLog.reduce((s, x) => s + x.gasUsed, 0n);
  console.log(`deploy-lighter-oracles (${phase}): OK (${gasLog.length} transaction(s), gas used ${total})`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
