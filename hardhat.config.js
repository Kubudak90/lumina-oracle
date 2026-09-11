require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;

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
    },
    etherscan: {
        apiKey: {
            baseSepolia: process.env.ETHERSCAN_API_KEY_BASE || process.env.ETHERSCAN_API_KEY || "",
        },
    },
};
