const { ethers, network, artifacts } = require("hardhat");

const READ_CORE = "0x6600000000000000000000000000000000000000";
const MOCK_READ_CORE = "contracts/lighter/test/MockReadCore.sol:MockReadCore";
const DEFAULT_STIPEND = 100_000n;

/** Etches a contract's runtime bytecode at READ_CORE and returns it attached there. */
async function etchReadCore(fullyQualifiedName = MOCK_READ_CORE) {
  const artifact = await artifacts.readArtifact(fullyQualifiedName);
  await network.provider.send("hardhat_setCode", [READ_CORE, artifact.deployedBytecode]);
  return ethers.getContractAt(fullyQualifiedName, READ_CORE);
}

/** Seeds a READ_CORE market with plausible non-price fields. */
async function setMarket(core, id, { marketType = 0, indexPrice, markPrice = indexPrice }) {
  return core.setMarket(id, marketType, 1, 5, 20, 5, 1_000_000, 1_000_000, 50, indexPrice, markPrice);
}

async function deploy(name, ...args) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function now() {
  return BigInt((await ethers.provider.getBlock("latest")).timestamp);
}

async function setNextTimestamp(timestamp) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
}

async function mineAt(timestamp) {
  await setNextTimestamp(timestamp);
  await network.provider.send("evm_mine", []);
}

/** Deterministic SplitMix64 PRNG over BigInt, so property tests are reproducible. */
function rng(seed) {
  let state = BigInt.asUintN(64, BigInt(seed));
  const next64 = () => {
    state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n);
    let z = state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  };
  const below = (n) => next64() % BigInt(n); // n <= 2^64; modulo bias is irrelevant here
  return {
    next64,
    below,
    int: (min, max) => Number(BigInt(min) + below(BigInt(max) - BigInt(min) + 1n)),
    big: (min, max) => BigInt(min) + below(BigInt(max) - BigInt(min) + 1n),
    chance: (p) => Number(below(1_000_000n)) < p * 1_000_000,
    pick: (items) => items[Number(below(items.length))],
    // log-uniform positive integer in [1, 2^bits)
    magnitude: (bits) => {
      const b = BigInt(1 + Number(below(BigInt(bits))));
      return (next64() % (1n << b)) | 1n;
    },
  };
}

/** Guard status enum, in declaration order. */
const Status = {
  OK: 0n,
  PAUSED: 1n,
  NO_MARKETS: 2n,
  NO_REFERENCE: 3n,
  REFERENCE_STALE: 4n,
  CORE_PRICE_STALE: 5n,
  CORE_READ_FAILED: 6n,
  DEVIATION: 7n,
};

module.exports = {
  READ_CORE,
  MOCK_READ_CORE,
  DEFAULT_STIPEND,
  etchReadCore,
  setMarket,
  deploy,
  now,
  setNextTimestamp,
  mineAt,
  rng,
  Status,
};
