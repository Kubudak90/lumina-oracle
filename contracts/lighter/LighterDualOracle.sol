// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "../interfaces/IERC20.sol";
import {IDualOracle, IERC165} from "./interfaces/IDualOracle.sol";

/// @notice An 8-decimal USD price source (`LighterCorePriceSource` or `FixedPriceSource`).
interface ILighterPriceSource {
    function latestAnswer() external view returns (int256);
}

/// @notice The borrow guard (`LuminaPriceGuard`).
interface ILighterBorrowGuard {
    function isBorrowAllowed() external view returns (bool);
}

/// @title LighterDualOracle
/// @notice FraxLend `IDualOracle` for a Lumina isolated pair on Lighter.
///
/// Exchange rate = collateral units per asset unit × 1e18 (`ORACLE_PRECISION`), in the
/// `DualOracleChainlinkUniV3` normalization with both feeds at 8 decimals (multiply = asset USD
/// price, divide = collateral USD price):
///
///     rate = 1e36 × assetPrice / (collateralPrice × 10^(18 + assetDecimals − collateralDecimals))
///
/// computed with a single division. `getPrices()` returns `(isBadData, rate, rate)` with
/// `isBadData = !guard.isBorrowAllowed()`: the pair then blocks new borrows (and collateral
/// removal by borrowers) while repay, add-collateral, lending and liquidation keep working.
/// Keeper reference prices are never used in the rate: a compromised keeper can only set
/// `isBadData`, never move valuations. A failed source read reverts (no price, no fallback).
contract LighterDualOracle is IDualOracle {
    uint256 public constant override ORACLE_PRECISION = 1e18;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant MAX_TOKEN_DECIMALS = 18;

    /// @notice Pair asset (FraxLend `BASE_TOKEN`) and collateral (`QUOTE_TOKEN`).
    address public immutable ASSET;
    address public immutable COLLATERAL;
    uint256 public immutable ASSET_DECIMALS;
    uint256 public immutable COLLATERAL_DECIMALS;

    ILighterPriceSource public immutable ASSET_PRICE_SOURCE;
    ILighterPriceSource public immutable COLLATERAL_PRICE_SOURCE;
    ILighterBorrowGuard public immutable GUARD;

    /// @notice 10^(18 + assetDecimals − collateralDecimals).
    uint256 public immutable RATE_NORMALIZATION;

    string private _name;

    error ZeroAddress();
    error UnsupportedDecimals();
    error InvalidSourcePrice(address source, int256 price);
    error ZeroRate();

    constructor(
        address asset,
        address collateral,
        ILighterPriceSource assetPriceSource,
        ILighterPriceSource collateralPriceSource,
        ILighterBorrowGuard guard,
        string memory name_
    ) {
        if (
            asset == address(0) || collateral == address(0) || address(assetPriceSource) == address(0)
                || address(collateralPriceSource) == address(0) || address(guard) == address(0)
        ) revert ZeroAddress();
        uint256 assetDecimals = IERC20(asset).decimals();
        uint256 collateralDecimals = IERC20(collateral).decimals();
        if (assetDecimals > MAX_TOKEN_DECIMALS || collateralDecimals > MAX_TOKEN_DECIMALS) {
            revert UnsupportedDecimals();
        }
        ASSET = asset;
        COLLATERAL = collateral;
        ASSET_DECIMALS = assetDecimals;
        COLLATERAL_DECIMALS = collateralDecimals;
        ASSET_PRICE_SOURCE = assetPriceSource;
        COLLATERAL_PRICE_SOURCE = collateralPriceSource;
        GUARD = guard;
        // Exponent >= 0 because both decimals are <= 18.
        RATE_NORMALIZATION = 10 ** (18 + assetDecimals - collateralDecimals);
        _name = name_;
    }

    // --------------------------------------------------------------------------- prices

    /// @inheritdoc IDualOracle
    function getPrices() external view override returns (bool isBadData, uint256 priceLow, uint256 priceHigh) {
        uint256 rate = _rate();
        return (_isBadData(), rate, rate);
    }

    /// @notice Same as `getPrices()` but in whole-token terms (1e18 = one collateral token per
    /// asset token): the rate divided by 10^NORMALIZATION when positive, else multiplied.
    function getPricesNormalized()
        external
        view
        override
        returns (bool isBadData, uint256 priceLow, uint256 priceHigh)
    {
        uint256 rate = _normalize(_rate());
        return (_isBadData(), rate, rate);
    }

    function _rate() internal view returns (uint256 rate) {
        uint256 assetPrice = _read(ASSET_PRICE_SOURCE);
        uint256 collateralPrice = _read(COLLATERAL_PRICE_SOURCE);
        // Checked arithmetic: with realistic source bounds (MAX_PRICE ≪ 1e40) nothing overflows;
        // an absurd price reverts instead of wrapping.
        rate = (1e36 * assetPrice) / (collateralPrice * RATE_NORMALIZATION);
        if (rate == 0) revert ZeroRate();
    }

    function _read(ILighterPriceSource source) internal view returns (uint256) {
        int256 answer = source.latestAnswer();
        if (answer <= 0) revert InvalidSourcePrice(address(source), answer);
        return uint256(answer);
    }

    /// @dev A guard that reverts counts as bad data.
    function _isBadData() internal view returns (bool) {
        try GUARD.isBorrowAllowed() returns (bool allowed) {
            return !allowed;
        } catch {
            return true;
        }
    }

    function _normalize(uint256 rate) internal view returns (uint256) {
        int256 normalization = NORMALIZATION_0();
        if (normalization > 0) return rate / 10 ** uint256(normalization);
        return rate * 10 ** uint256(-normalization);
    }

    // ------------------------------------------------------------------ IDualOracle getters

    function BASE_TOKEN_0() external view override returns (address) {
        return ASSET;
    }

    function BASE_TOKEN_0_DECIMALS() external view override returns (uint256) {
        return ASSET_DECIMALS;
    }

    function BASE_TOKEN_1() external view override returns (address) {
        return ASSET;
    }

    function BASE_TOKEN_1_DECIMALS() external view override returns (uint256) {
        return ASSET_DECIMALS;
    }

    function QUOTE_TOKEN_0() external view override returns (address) {
        return COLLATERAL;
    }

    function QUOTE_TOKEN_0_DECIMALS() external view override returns (uint256) {
        return COLLATERAL_DECIMALS;
    }

    function QUOTE_TOKEN_1() external view override returns (address) {
        return COLLATERAL;
    }

    function QUOTE_TOKEN_1_DECIMALS() external view override returns (uint256) {
        return COLLATERAL_DECIMALS;
    }

    /// @notice collateralDecimals − assetDecimals.
    function NORMALIZATION_0() public view override returns (int256) {
        return int256(COLLATERAL_DECIMALS) - int256(ASSET_DECIMALS);
    }

    function NORMALIZATION_1() external view override returns (int256) {
        return NORMALIZATION_0();
    }

    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    function name() external view override returns (string memory) {
        return _name;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IDualOracle).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
