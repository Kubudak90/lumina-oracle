require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
// Lighter EVM devnet (chain 19529): the RPC URL comes from the env var the deployment manifest names
// (`rpcEnv`). No `accounts`: transactions go through the node's accounts (unlocked anvil accounts on
// the local harness). See scripts/deploy-lighter-oracles.js.
const LIGHTER_DEVNET_RPC_URL = process.env.LIGHTER_DEVNET_RPC_URL;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        compilers: [
            {
                version: "0.8.20",
                settings: {
                    optimizer: { enabled: true, runs: 200 },
                    viaIR: true,
                },
            },
            {
                version: "0.8.19",
                settings: {
                    optimizer: { enabled: true, runs: 200 },
                    viaIR: true,
                },
            },
        ],
    },
    networks: {
        hardhat: {
            chainId: 31337,
        },
        baseSepolia: {
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
            chainId: 84532,
            url: "https://sepolia.base.org",
        },
        ...(LIGHTER_DEVNET_RPC_URL
            ? { lighterDevnet: { url: LIGHTER_DEVNET_RPC_URL, chainId: 19529, timeout: 120000 } }
            : {}),
    },
    etherscan: {
        apiKey: {
            baseSepolia: process.env.ETHERSCAN_API_KEY_BASE || process.env.ETHERSCAN_API_KEY || "",
        },
    },
};
