// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title WrappedUSDT (wUSDT)
 * @notice Wrapped Tether USDT minted only against attested real-USDT reserves
 *         held in the per-chain MasterVault, and burned on the way back out.
 *
 * Supply invariant enforced in code: only the configured minter (the Treasury
 * Vault / mint engine signer) can mint, and minting is what the mint cycle does
 * per attested reservation. Nothing else can create supply.
 *
 * Self-contained (no external imports) so the contract compiles standalone with
 * solc in the sandbox and in CI.
 */
contract WrappedUSDT {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    address public governor;
    address public minter;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterUpdated(address indexed previousMinter, address indexed newMinter);
    event GovernorUpdated(address indexed previousGovernor, address indexed newGovernor);

    modifier onlyGovernor() {
        require(msg.sender == governor, "not governor");
        _;
    }

    modifier onlyMinter() {
        require(msg.sender == minter, "not minter");
        _;
    }

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address governor_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        governor = governor_;
    }

    /// @notice Mint new wrapped supply. Minter role only — the mint engine sets
    /// the treasury vault signer as minter, exactly as the reserve rule requires.
    function mint(address to, uint256 amount) external onlyMinter {
        require(to != address(0), "mint to zero");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burn wrapped supply held by the caller (unwrap / redemption path).
    function burn(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "burn exceeds balance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    function setMinter(address newMinter) external onlyGovernor {
        emit MinterUpdated(minter, newMinter);
        minter = newMinter;
    }

    function setGovernor(address newGovernor) external onlyGovernor {
        require(newGovernor != address(0), "governor zero");
        emit GovernorUpdated(governor, newGovernor);
        governor = newGovernor;
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
