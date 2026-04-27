// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMintableOwnable {
    function mint(address to, uint256 amount) external;
    function transferOwnership(address newOwner) external;
}

/**
 * @title LuminaFaucet
 * @notice Public, rate-limited faucet for Lumina Finance Base Sepolia test tokens.
 *         Owns the underlying USDC + LIT token contracts (after transferOwnership)
 *         so anyone can call drip() to receive both at once, subject to a cooldown.
 */
contract LuminaFaucet {
    IMintableOwnable public immutable usdc;
    IMintableOwnable public immutable lit;
    uint256 public immutable usdcAmount;
    uint256 public immutable litAmount;
    uint256 public immutable cooldown;

    address public admin;
    mapping(address => uint256) public lastDrip;

    event Dripped(address indexed user, uint256 usdcAmount, uint256 litAmount);
    event AdminChanged(address indexed newAdmin);

    error CooldownActive(uint256 remainingSeconds);
    error NotAdmin();
    error ZeroAddress();

    constructor(
        address _usdc,
        address _lit,
        uint256 _usdcAmount,
        uint256 _litAmount,
        uint256 _cooldown
    ) {
        if (_usdc == address(0) || _lit == address(0)) revert ZeroAddress();
        usdc = IMintableOwnable(_usdc);
        lit = IMintableOwnable(_lit);
        usdcAmount = _usdcAmount;
        litAmount = _litAmount;
        cooldown = _cooldown;
        admin = msg.sender;
    }

    /// @notice Public faucet: mints USDC + LIT to msg.sender once per cooldown.
    function drip() external {
        uint256 last = lastDrip[msg.sender];
        if (last != 0 && block.timestamp < last + cooldown) {
            revert CooldownActive(last + cooldown - block.timestamp);
        }
        lastDrip[msg.sender] = block.timestamp;
        usdc.mint(msg.sender, usdcAmount);
        lit.mint(msg.sender, litAmount);
        emit Dripped(msg.sender, usdcAmount, litAmount);
    }

    /// @notice Seconds remaining until `user` can drip again. 0 if available now.
    function timeUntilNext(address user) external view returns (uint256) {
        uint256 last = lastDrip[user];
        if (last == 0) return 0;
        uint256 next = last + cooldown;
        if (block.timestamp >= next) return 0;
        return next - block.timestamp;
    }

    /// @notice Admin escape hatch: pull token ownership back (e.g. to upgrade faucet).
    function recoverOwnership(address token, address newOwner) external {
        if (msg.sender != admin) revert NotAdmin();
        IMintableOwnable(token).transferOwnership(newOwner);
    }

    function setAdmin(address newAdmin) external {
        if (msg.sender != admin) revert NotAdmin();
        if (newAdmin == address(0)) revert ZeroAddress();
        admin = newAdmin;
        emit AdminChanged(newAdmin);
    }
}
