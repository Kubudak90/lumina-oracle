require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        compilers: [
            {
                version: "0.8.20",
            },
            {
                version: "0.8.19",
            },
        ],
    },
    networks: {
        lighterEvmTestnet: {
            accounts: [PRIVATE_KEY],
            chainId: 998,
            url: "https://rpc.hyperliquid-testnet.xyz/evm",
            forking: {
                url: "https://rpc.hyperliquid-testnet.xyz/evm",
            }
        },
        lighterEvm: {
            accounts: [PRIVATE_KEY],
            chainId: 999,
            url: "https://rpc.hyperliquid.xyz/evm",
            forking: {
                url: "https://rpc.hyperliquid.xyz/evm",
            }
        }
    },
    etherscan: {
        apiKey: {
            lighterEvmTestnet: "empty",
            lighterEvm: process.env.ETHERSCAN_API_KEY
        },
        customChains: [
            {
                network: "lighterEvmTestnet",
                chainId: 998,
                urls: {
                    apiURL: "https://explorer.lightlend.finance/api",
                    browserURL: "https://explorer.lightlend.finance"
                }
            },
            {
                network: "lighterEvm",
                chainId: 999,
                urls: {
                    apiURL: "https://api.etherscan.io/v2/api?chainId=999",
                    browserURL: "https://www.hyperevmscan.io"
                }
            }
        ]
    },
    sourcify: {
        enabled: true,
        apiUrl: "https://sourcify.parsec.finance",
        browserUrl: "https://purrsec.com/",
    }
};
