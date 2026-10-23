// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockUSDT — local-chain stand-in for the OFFICIAL Tether USDT contract
 *
 * On a public chain the platform talks to Tether's own deployed USDT contract
 * (address from the chain registry) and never mints it. On the local devnet
 * chain there is no Tether deployment, so this contract supplies the same
 * interface and — crucially — the same per-chain decimals (6 everywhere,
 * 18 on BSC), so all decimals-aware math is exercised for real.
 *
 * `mint` is the devnet faucet used once at bootstrap to fund the custody and
 * DEX-reserve balances. It is never reachable in live mode: live mode points at
 * the official contract address, not at this one.
 */
contract MockUSDT {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 decimals_) {
        name = "Tether USD (local devnet)";
        symbol = "USDT";
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        require(to != address(0), "mint to zero");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance exceeded");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "transfer to zero");
        require(balanceOf[from] >= amount, "balance exceeded");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
