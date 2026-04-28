/**
 * Deploys the AssetListingProxy and grants it AssetListingAdmin on the ACLManager.
 *
 *   npx hardhat run scripts/deploy/deployAssetListingProxy.js --network baseSepolia
 *
 * Caller must be PoolAdmin (or otherwise able to grant asset-listing roles).
 */
const hre = require("hardhat");

const CONFIG_ENGINE = "0x84198a3f1646270d307b1a79a5b71e7f27966f8a";
const ACL_MANAGER = "0x3c2d4de687bb02741b6910fe5470c86f15bd6a2e";

const ACL_ABI = [
    "function addAssetListingAdmin(address admin) external",
    "function isAssetListingAdmin(address admin) external view returns (bool)",
];

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Network: ", hre.network.name);

    // 1. Deploy
    console.log("\n[1/3] Deploying AssetListingProxy…");
    const Proxy = await hre.ethers.deployContract("AssetListingProxy", [
        CONFIG_ENGINE,
        deployer.address,
    ]);
    await Proxy.waitForDeployment();
    const proxyAddr = await Proxy.getAddress();
    console.log("  → deployed:", proxyAddr);

    // 2. Grant AssetListingAdmin role
    console.log("\n[2/3] Granting AssetListingAdmin to proxy…");
    const acl = await hre.ethers.getContractAt(ACL_ABI, ACL_MANAGER, deployer);
    const tx = await acl.addAssetListingAdmin(proxyAddr);
    console.log("  → tx:", tx.hash);
    await tx.wait();
    const isAdmin = await acl.isAssetListingAdmin(proxyAddr);
    console.log("  → isAssetListingAdmin:", isAdmin);

    console.log("\n[3/3] Done.");
    console.log("════════════════════════════════════════════════════════════");
    console.log("AssetListingProxy:", proxyAddr);
    console.log("ConfigEngine:     ", CONFIG_ENGINE);
    console.log("Add to frontend ADDRESSES.assetListingProxy");
    console.log("════════════════════════════════════════════════════════════");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
