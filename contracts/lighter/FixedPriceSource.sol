// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {LighterPriceSourceBase} from "./LighterPriceSourceBase.sol";

/// @title FixedPriceSource
/// @notice Constant 8-decimal price (devnet: USDC = 1e8, the convention Lighter Core uses for
/// collateral). A depeg is out of scope for devnet and is not detected.
contract FixedPriceSource is LighterPriceSourceBase {
    uint256 public immutable PRICE;

    string private _description;

    error InvalidPrice();

    constructor(uint256 price, string memory description_) {
        if (price == 0 || price > uint256(type(int256).max)) revert InvalidPrice();
        PRICE = price;
        _description = description_;
    }

    function description() external view override returns (string memory) {
        return _description;
    }

    function _price() internal view override returns (uint256) {
        return PRICE;
    }
}
