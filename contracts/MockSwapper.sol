// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockSwapper
 * @notice Fixed-rate ISwapper implementation for the Lumina Looping contract on
 *         Base Sepolia testnet. Uses admin-set USD prices (1e8) and pre-funded
 *         reserves so leveraged-position flows can be exercised end-to-end
 *         without a real DEX.
 *
 * @dev Matches the ISwapper interface used by Looping:
 *        function swapExactTokensForTokensSupportingFeeOnTransferTokens(
 *            uint amountIn, uint amountOutMin,
 *            address[] path, address to, address referrer, uint deadline
 *        ) external;
 */
contract MockSwapper {
    using SafeERC20 for IERC20;

    /// price in 1e8 USD units (Chainlink-style)
    mapping(address => uint256) public priceUsd1e8;
    /// cached decimals per token (set together with price)
    mapping(address => uint8) public tokenDecimals;

    address public admin;

    event Swapped(
        address indexed from,
        address indexed to,
        uint256 amountIn,
        uint256 amountOut,
        address[] path
    );
    event PriceSet(address indexed token, uint256 priceUsd1e8, uint8 decimals);
    event AdminChanged(address indexed newAdmin);

    error NotAdmin();
    error PathTooShort();
    error InsufficientOutput();
    error Expired();
    error PriceMissing(address token);
    error ZeroAddress();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function setPrice(address token, uint256 price1e8, uint8 decimals_) external onlyAdmin {
        if (token == address(0)) revert ZeroAddress();
        priceUsd1e8[token] = price1e8;
        tokenDecimals[token] = decimals_;
        emit PriceSet(token, price1e8, decimals_);
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        admin = newAdmin;
        emit AdminChanged(newAdmin);
    }

    /// @notice Get the swap output amount for a given input.
    function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut) public view returns (uint256) {
        uint256 priceIn = priceUsd1e8[tokenIn];
        uint256 priceOut = priceUsd1e8[tokenOut];
        if (priceIn == 0) revert PriceMissing(tokenIn);
        if (priceOut == 0) revert PriceMissing(tokenOut);
        uint8 decIn = tokenDecimals[tokenIn];
        uint8 decOut = tokenDecimals[tokenOut];
        return (amountIn * priceIn * (10 ** decOut)) / (priceOut * (10 ** decIn));
    }

    /// @notice ISwapper-compatible swap. Walks `path` and applies fixed-rate exchange at each hop.
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        address /* referrer */,
        uint256 deadline
    ) external {
        if (block.timestamp > deadline) revert Expired();
        if (path.length < 2) revert PathTooShort();

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 amount = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            amount = getAmountOut(amount, path[i], path[i + 1]);
        }

        if (amount < amountOutMin) revert InsufficientOutput();

        IERC20(path[path.length - 1]).safeTransfer(to, amount);

        emit Swapped(msg.sender, to, amountIn, amount, path);
    }

    /// @notice Admin can withdraw any token from the swapper (e.g. unused reserves).
    function withdraw(address token, address to, uint256 amount) external onlyAdmin {
        IERC20(token).safeTransfer(to, amount);
    }
}
