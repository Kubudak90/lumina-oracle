// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IConfigEngine {
    struct InterestRateInputData {
        uint256 optimalUsageRatio;
        uint256 baseVariableBorrowRate;
        uint256 variableRateSlope1;
        uint256 variableRateSlope2;
    }
    struct PoolContext {
        string networkName;
        string networkAbbreviation;
    }
    struct Listing {
        address asset;
        string assetSymbol;
        address priceFeed;
        InterestRateInputData rateStrategyParams;
        uint256 enabledToBorrow;
        uint256 borrowableInIsolation;
        uint256 withSiloedBorrowing;
        uint256 flashloanable;
        uint256 ltv;
        uint256 liqThreshold;
        uint256 liqBonus;
        uint256 reserveFactor;
        uint256 supplyCap;
        uint256 borrowCap;
        uint256 debtCeiling;
        uint256 liqProtocolFee;
    }
}

/**
 * @title AssetListingProxy
 * @notice Admin-gated wrapper that holds the AssetListingAdmin role on ACLManager
 *         and forwards Aave V3 ConfigEngine calls via DELEGATECALL. EOAs can't
 *         delegatecall, so this contract is the only way the deployer wallet can
 *         actually drive ConfigEngine listings.
 */
contract AssetListingProxy {
    address public immutable CONFIG_ENGINE;
    address public owner;

    event OwnerChanged(address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error CallFailed(bytes returndata);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address configEngine, address _owner) {
        if (configEngine == address(0) || _owner == address(0)) revert ZeroAddress();
        CONFIG_ENGINE = configEngine;
        owner = _owner;
    }

    /// @notice Forwards listAssets to ConfigEngine via delegatecall so msg.sender
    ///         at PoolConfigurator becomes this proxy (which holds the role).
    function listAssets(
        IConfigEngine.PoolContext calldata context,
        IConfigEngine.Listing[] calldata listings
    ) external onlyOwner {
        bytes memory data = abi.encodeWithSelector(
            // listAssets((string,string),(address,string,address,(uint256,uint256,uint256,uint256),uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)[])
            bytes4(0xb668509b),
            context,
            listings
        );
        (bool success, bytes memory ret) = CONFIG_ENGINE.delegatecall(data);
        if (!success) revert CallFailed(ret);
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }
}
