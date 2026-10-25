// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./WrappedUSDT.sol";

/**
 * @title TreasuryVault
 * @notice Holds the shadow wUSDT reserve, mints it against replay-protected
 *         bridge messages, runs the 25 % distribution cycle, and records the
 *         releases that take real USDT back out.
 *
 * This is the contract the "Enhanced Wrapped Asset (wUSDT) Implementation"
 * review asks for:
 *   · `injectNetReserve(messageId, amount)` — the ONLY way supply appears. A
 *     message id can never be processed twice (a replayed bridge message would
 *     otherwise be an infinite mint), and the reserve is capped.
 *   · a shadow ledger (`currentReserve`) that is the source of truth for reserve
 *     arithmetic — never `balanceOf`, which any transfer can move;
 *   · bounded batch distribution (MAX_BATCH) with the un-splittable dust
 *     re-absorbed into the ledger instead of silently dropped;
 *   · `confirmRedemption` — closes the burn → real-USDT-release loop that the
 *     token's `requestRedemption` opens, with per-request replay protection;
 *   · `releaseReserve` — the operator release the platform's own payouts
 *     (transfer-out / swap / liquidation) use when the reserve has to leave the
 *     vault. This is the platform-side counterpart of a redemption, which
 *     releases on the source chain instead;
 *   · role separation (admin / bridge / operator / pauser), an emergency stop,
 *     checks-effects-interactions and a reentrancy guard.
 *
 * The vault is the token's minter: `WrappedUSDT.setMinter(vault)` is what makes
 * the ledger above the only source of supply.
 *
 * Self-contained (one local import) so it compiles with solc in the sandbox.
 */
contract TreasuryVault {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant BPS_DENOM = 10_000;
    /// @notice 25 % of the reserve moves out on every distribution cycle.
    uint256 public constant DISTRIBUTE_BPS = 2_500;
    /// @notice DoS guard: a distribution batch is bounded.
    uint256 public constant MAX_BATCH = 200;
    /// @notice The platform's $10M reserve target, in the token's decimals.
    uint256 public constant DEFAULT_MAX_RESERVE_USD = 10_000_000;

    WrappedUSDT public immutable wUSDT;
    uint8 public immutable decimals;

    /// @notice Ceiling on `currentReserve`. Governance can raise it for a refill.
    uint256 public maxReserve;

    /// @notice Shadow ledger — the reserve the platform has minted and not paid out.
    uint256 public currentReserve;
    /// @notice Cumulative amount released through confirmed redemptions. Those
    ///         tokens were burned by holders, so the vault balance does not move:
    ///         `expectedVaultBalance() = currentReserve + redemptionReleased`.
    uint256 public redemptionReleased;

    bool public paused;
    uint256 private _lock = 1;

    /// @notice Bridge message ids already injected (replay protection).
    mapping(bytes32 => bool) public processedMessages;
    /// @notice Redemption ids already released (replay protection).
    mapping(bytes32 => bool) public releasedRedemptions;

    mapping(bytes32 => mapping(address => bool)) private roles;
    address public governor;

    event MintCycleTriggered(bytes32 indexed messageId, uint256 amount, uint256 newReserve);
    event DistributionExecuted(address indexed operator, uint256 total, uint256 walletCount, uint256 dustRetained);
    event RedemptionReleased(bytes32 indexed requestId, address indexed user, uint256 amount, uint256 newReserve);
    event ReserveReleased(address indexed to, uint256 amount, uint256 newReserve);
    event MaxReserveUpdated(uint256 previousMaxReserve, uint256 newMaxReserve);
    event GovernorUpdated(address indexed previousGovernor, address indexed newGovernor);
    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);
    event Paused(address indexed account);
    event Unpaused(address indexed account);

    error AlreadyProcessed(bytes32 id);
    error CapacityExceeded(uint256 requested, uint256 available);
    error InsufficientReserve(uint256 requested, uint256 available);
    error EmptyBatch();
    error BatchTooLarge(uint256 size);
    error ZeroAmount();
    error ZeroAddress();

    modifier onlyRole(bytes32 role) {
        require(roles[role][msg.sender], "not authorised");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address wusdt_, address governor_, uint8 decimals_) {
        if (wusdt_ == address(0) || governor_ == address(0)) revert ZeroAddress();
        wUSDT = WrappedUSDT(wusdt_);
        decimals = decimals_;
        maxReserve = DEFAULT_MAX_RESERVE_USD * (10 ** uint256(decimals_));
        governor = governor_;
        roles[ADMIN_ROLE][governor_] = true;
        roles[PAUSER_ROLE][governor_] = true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bridge → vault injection
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Credit the reserve against a bridge message and mint the matching
     *         wUSDT into the vault.
     * @dev    BRIDGE_ROLE only. The message id is the replay key: a bridge that
     *         re-delivers the same message reverts here instead of minting twice.
     */
    function injectNetReserve(bytes32 messageId, uint256 amount)
        external
        onlyRole(BRIDGE_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (processedMessages[messageId]) revert AlreadyProcessed(messageId);
        if (currentReserve + amount > maxReserve) {
            revert CapacityExceeded(amount, maxReserve - currentReserve);
        }

        processedMessages[messageId] = true;
        currentReserve += amount;

        wUSDT.mint(address(this), amount);

        emit MintCycleTriggered(messageId, amount, currentReserve);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Distribution
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Distribute exactly 25 % of `currentReserve` across `wallets`.
     * @dev    The ledger moves before any token does (checks-effects-interactions)
     *         and only the amount that actually left the vault is deducted — the
     *         dust that cannot be split stays in the reserve, re-distributable on
     *         the next cycle.
     */
    function distributeToAppWallets(address[] calldata wallets)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        uint256 count = wallets.length;
        if (count == 0) revert EmptyBatch();
        if (count > MAX_BATCH) revert BatchTooLarge(count);

        uint256 total = (currentReserve * DISTRIBUTE_BPS) / BPS_DENOM;
        if (total == 0) revert ZeroAmount();

        uint256 perWallet = total / count;
        if (perWallet == 0) revert ZeroAmount();

        uint256 distributed = perWallet * count;
        currentReserve -= distributed;

        for (uint256 i = 0; i < count; ++i) {
            if (wallets[i] == address(0)) revert ZeroAddress();
            require(wallets[i] != address(this), "vault is not a recipient");
            require(wUSDT.transfer(wallets[i], perWallet), "transfer failed");
        }

        emit DistributionExecuted(msg.sender, distributed, count, total - distributed);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Releases
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Pay wUSDT out of the reserve to `to`.
     * @dev    OPERATOR_ROLE only. This is the platform's own payout path
     *         (console transfer-out, swap, liquidation); a holder redemption is
     *         the burn → `confirmRedemption` path instead.
     */
    function releaseReserve(address to, uint256 amount)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > currentReserve) revert InsufficientReserve(amount, currentReserve);

        currentReserve -= amount;

        require(wUSDT.transfer(to, amount), "transfer failed");

        emit ReserveReleased(to, amount, currentReserve);
    }

    /**
     * @notice Record that the source-chain USDT for a holder's redemption
     *         request has been released, and take it out of the reserve.
     * @dev    OPERATOR_ROLE only. `requestId` comes from the token's
     *         `RedemptionRequested` event and can only be released once.
     */
    function confirmRedemption(bytes32 requestId, address user, uint256 amount)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (releasedRedemptions[requestId]) revert AlreadyProcessed(requestId);
        if (amount > currentReserve) revert InsufficientReserve(amount, currentReserve);

        releasedRedemptions[requestId] = true;
        currentReserve -= amount;
        redemptionReleased += amount;

        emit RedemptionReleased(requestId, user, amount, currentReserve);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function getCurrentReserve() external view returns (uint256) {
        return currentReserve;
    }

    /// @notice How close the reserve is to its ceiling, in basis points.
    function getUtilizationBps() external view returns (uint256) {
        if (maxReserve == 0) return 0;
        return (currentReserve * BPS_DENOM) / maxReserve;
    }

    /**
     * @notice The vault's wUSDT balance the shadow ledger implies.
     * @dev    Reconciliation view: redemptions leave the vault balance untouched
     *         (the holder burned their own tokens), so the expected balance is
     *         the reserve plus everything released through redemptions.
     */
    function expectedVaultBalance() external view returns (uint256) {
        return currentReserve + redemptionReleased;
    }

    /// @notice Signed reconciliation drift: expected balance minus the real one.
    function reserveDrift() external view returns (int256) {
        return int256(currentReserve + redemptionReleased) - int256(wUSDT.balanceOf(address(this)));
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return roles[role][account];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Raise (or lower) the reserve ceiling — a refill needs headroom.
    function setMaxReserve(uint256 newMaxReserve) external onlyRole(ADMIN_ROLE) {
        require(newMaxReserve >= currentReserve, "below current reserve");
        emit MaxReserveUpdated(maxReserve, newMaxReserve);
        maxReserve = newMaxReserve;
    }

    function grantRole(bytes32 role, address account) external onlyRole(ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (roles[role][account]) return;
        roles[role][account] = true;
        emit RoleGranted(role, account);
    }

    function revokeRole(bytes32 role, address account) external onlyRole(ADMIN_ROLE) {
        if (!roles[role][account]) return;
        roles[role][account] = false;
        emit RoleRevoked(role, account);
    }

    function setGovernor(address newGovernor) external onlyRole(ADMIN_ROLE) {
        if (newGovernor == address(0)) revert ZeroAddress();
        if (newGovernor == governor) return;
        roles[ADMIN_ROLE][newGovernor] = true;
        roles[PAUSER_ROLE][newGovernor] = true;
        roles[ADMIN_ROLE][governor] = false;
        roles[PAUSER_ROLE][governor] = false;
        emit RoleGranted(ADMIN_ROLE, newGovernor);
        emit RoleGranted(PAUSER_ROLE, newGovernor);
        emit GovernorUpdated(governor, newGovernor);
        governor = newGovernor;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        require(!paused, "already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        require(paused, "not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }
}
