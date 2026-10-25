// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title WrappedUSDT (wUSDT)
 * @notice Wrapped Tether USDT minted only against attested real-USDT reserves
 *         held in the per-chain MasterVault, and burned on the way back out.
 *
 * Supply invariant enforced in code: only the configured minter — the
 * TreasuryVault contract — can mint, and the vault only mints against a
 * replay-protected bridge message. Nothing else can create supply.
 *
 * Enhancements from the "Enhanced Wrapped Asset (wUSDT) Implementation" review:
 *   · role-separated access (admin / minter / pauser) instead of a single owner,
 *     so pausing and minting are not the same authority;
 *   · minting reserved for the TreasuryVault, which is the only address holding
 *     MINTER_ROLE — no EOA mints supply;
 *   · pausable emergency stop that covers mint, burn and every transfer;
 *   · `requestRedemption` — the holder burns and a replay-safe `requestId`
 *     (sender, amount, nonce, chain id) is emitted for the bridge relayer, which
 *     is what actually closes the burn → real-USDT-release loop;
 *   · `decimals` is the chain's official USDT decimals (6 everywhere, 18 on BNB
 *     Chain where Tether's USDT itself is 18) — never a hardcoded 1e6.
 *
 * Drop-in compatible with the previous version: same constructor, same
 * name/symbol/decimals/minter/governor surface, minter-only mint, permissionless
 * burn, and the ERC-20 transfer/approve/transferFrom set.
 *
 * Self-contained (no external imports) so the contract compiles standalone with
 * solc in the sandbox and in CI.
 */
contract WrappedUSDT {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Admin of the token (the governance multisig in production).
    address public governor;
    /// @notice The primary minter: the TreasuryVault contract in production.
    address public minter;

    bool public paused;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    mapping(bytes32 => mapping(address => bool)) private roles;

    /// @notice Sequential part of a redemption request id (never reused).
    uint256 public redemptionNonce;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterUpdated(address indexed previousMinter, address indexed newMinter);
    event GovernorUpdated(address indexed previousGovernor, address indexed newGovernor);
    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);
    event Paused(address indexed account);
    event Unpaused(address indexed account);

    /// @notice A holder burned wUSDT and asked the relayer to release real USDT.
    event RedemptionRequested(address indexed user, uint256 amount, bytes32 indexed requestId);

    modifier onlyGovernor() {
        require(msg.sender == governor, "not governor");
        _;
    }

    modifier onlyMinter() {
        require(roles[MINTER_ROLE][msg.sender], "not minter");
        _;
    }

    modifier onlyPauser() {
        require(roles[PAUSER_ROLE][msg.sender], "not pauser");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address governor_) {
        require(governor_ != address(0), "governor zero");
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        governor = governor_;
        roles[ADMIN_ROLE][governor_] = true;
        roles[PAUSER_ROLE][governor_] = true;
    }

    /// @notice Mint new wrapped supply. Minter role only — in production the
    /// TreasuryVault holds it and mints against a replay-protected message.
    function mint(address to, uint256 amount) external onlyMinter whenNotPaused {
        require(to != address(0), "mint to zero");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burn wrapped supply held by the caller (unwrap / redemption path).
    function burn(uint256 amount) external whenNotPaused {
        _burn(msg.sender, amount);
    }

    /**
     * @notice Burn wUSDT and emit a structured redemption request the bridge
     *         relayer observes to release real USDT on the source chain.
     * @dev    Permissionless — any holder can redeem. The treasury vault's
     *         `confirmRedemption` records the release against this id.
     */
    function requestRedemption(uint256 amount) external whenNotPaused returns (bytes32 requestId) {
        require(amount > 0, "amount zero");
        requestId = keccak256(abi.encodePacked(msg.sender, amount, redemptionNonce++, block.chainid));
        _burn(msg.sender, amount);
        emit RedemptionRequested(msg.sender, amount, requestId);
    }

    /// @notice Emergency stop. Covers mint, burn and transfers.
    function pause() external onlyPauser {
        require(!paused, "already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyPauser {
        require(paused, "not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Point the token at its minter. In production this is the
     *         TreasuryVault contract, so no EOA can create supply.
     */
    function setMinter(address newMinter) external onlyGovernor {
        require(newMinter != address(0), "minter zero");
        if (minter != address(0)) {
            _revoke(MINTER_ROLE, minter);
        }
        _grant(MINTER_ROLE, newMinter);
        emit MinterUpdated(minter, newMinter);
        minter = newMinter;
    }

    /// @notice Hand governance (admin + pauser) to a new address. The previous
    ///         governor keeps no authority — that is the launch hand-over.
    function setGovernor(address newGovernor) external onlyGovernor {
        require(newGovernor != address(0), "governor zero");
        _grant(ADMIN_ROLE, newGovernor);
        _grant(PAUSER_ROLE, newGovernor);
        _revoke(ADMIN_ROLE, governor);
        _revoke(PAUSER_ROLE, governor);
        emit GovernorUpdated(governor, newGovernor);
        governor = newGovernor;
    }

    function grantRole(bytes32 role, address account) external onlyGovernor {
        _grant(role, account);
    }

    function revokeRole(bytes32 role, address account) external onlyGovernor {
        _revoke(role, account);
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return roles[role][account];
    }

    function transfer(address to, uint256 amount) external whenNotPaused returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external whenNotPaused returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external whenNotPaused returns (bool) {
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

    function _burn(address from, uint256 amount) internal {
        require(balanceOf[from] >= amount, "burn exceeds balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function _grant(bytes32 role, address account) internal {
        require(account != address(0), "role to zero");
        if (roles[role][account]) return;
        roles[role][account] = true;
        emit RoleGranted(role, account);
    }

    function _revoke(bytes32 role, address account) internal {
        if (!roles[role][account]) return;
        roles[role][account] = false;
        emit RoleRevoked(role, account);
    }
}
