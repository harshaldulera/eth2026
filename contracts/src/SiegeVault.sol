// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SiegeVault
/// @notice One contract, many vaults. An Owner's pot sits here; every op that fails to breach has its
///         fee forwarded in and split (owner / pot / arena); a breach pays the whole pot, plus that
///         op's fee, to the Operator, but only with a signature from the verifier key.
/// @dev On Hedera EVM all value amounts (msg.value, balances) are tinybars (1 HBAR = 1e8).
///      The JSON-RPC relay exposes 18-decimal "weibars" to tooling; convert at the client edge.
///      Words follow the game: Guard, Owner, Operator, Vault, Op, Breach.
contract SiegeVault {
    enum Status {
        None,
        Open,
        Breached,
        Closed
    }

    /// @notice Why a vault closed. Expired needs the deadline; OrdersChanged is the arena's auto-close
    ///         when a guard's prompt hash changes; OwnerClosed is the Owner's choice,
    ///         sent by the arena on the Owner's behalf.
    enum CloseReason {
        Expired,
        OrdersChanged,
        OwnerClosed
    }

    struct Vault {
        address owner;
        uint256 pot;
        uint256 fee;
        uint64 deadline;
        Status status;
        uint32 streak;
    }

    /// @notice The arena operator: the only account that creates vaults and forwards fees.
    address public immutable arena;
    /// @notice The verifier key's address. Its private key lives only in the worker process.
    address public immutable verifier;
    uint16 public immutable ownerBps;
    uint16 public immutable potBps;
    uint16 public immutable arenaBps;
    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 public constant RELEASE_TYPEHASH =
        keccak256("Release(uint256 vaultId,address operator,bytes32 transcriptHash,bytes32 opId)");

    uint256 public nextVaultId = 1;
    mapping(uint256 => Vault) public vaults;
    /// @notice Metadata: the tool call that counts as a breach ("unlock_vault" for hosted guards,
    ///         whatever an external harness protected, e.g. "issue_refund").
    mapping(uint256 => string) public protectedTool;
    mapping(address => uint256) public ownerBalance;
    uint256 public arenaBalance;
    /// @notice Every op id can be settled on chain exactly once (attempt or release).
    mapping(bytes32 => bool) public opConsumed;

    event VaultCreated(
        uint256 indexed vaultId, address indexed owner, uint256 pot, uint256 fee, uint64 deadline, string protectedTool
    );
    event AttemptRecorded(
        uint256 indexed vaultId,
        bytes32 indexed opId,
        address indexed operator,
        uint256 ownerCut,
        uint256 potCut,
        uint256 arenaCut,
        uint256 newPot,
        uint32 streak
    );
    event Breached(uint256 indexed vaultId, bytes32 indexed opId, address indexed operator, bytes32 transcriptHash, uint256 amount);
    event VaultClosed(uint256 indexed vaultId, uint256 refunded, CloseReason reason);
    event Withdrawn(address indexed who, uint256 amount);

    error NotArena();
    error BadArgs();
    error BadStatus();
    error Expired();
    error NotExpired();
    error WrongFee();
    error Replay();
    error BadSignature();
    error PayFailed();
    error NotAllowed();

    constructor(address _arena, address _verifier, uint16 _ownerBps, uint16 _potBps, uint16 _arenaBps) {
        if (_arena == address(0) || _verifier == address(0)) revert BadArgs();
        if (uint256(_ownerBps) + _potBps + _arenaBps != 10_000) revert BadArgs();
        arena = _arena;
        verifier = _verifier;
        ownerBps = _ownerBps;
        potBps = _potBps;
        arenaBps = _arenaBps;
        // Version 2: the Release type speaks the game's words (operator, opId). A version-1 signature
        // can never verify against this contract.
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SiegeVault"),
                keccak256("2"),
                block.chainid,
                address(this)
            )
        );
    }

    modifier onlyArena() {
        if (msg.sender != arena) revert NotArena();
        _;
    }

    /// @notice Open a vault. msg.value is the starting pot. The arena signs on the Owner's behalf
    ///         for the hackathon; dropping onlyArena lets Owners call it from their own wallet.
    function createVault(uint256 fee, uint64 duration, address owner, string calldata tool)
        external
        payable
        onlyArena
        returns (uint256 vaultId)
    {
        if (msg.value == 0 || fee == 0 || duration == 0 || owner == address(0)) revert BadArgs();
        if (bytes(tool).length == 0 || bytes(tool).length > 64) revert BadArgs();
        vaultId = nextVaultId++;
        uint64 deadline = uint64(block.timestamp) + duration;
        vaults[vaultId] = Vault(owner, msg.value, fee, deadline, Status.Open, 0);
        protectedTool[vaultId] = tool;
        emit VaultCreated(vaultId, owner, msg.value, fee, deadline, tool);
    }

    /// @notice An op the guard held: forward exactly the fee the Operator paid via x402 and split it.
    function recordAttempt(uint256 vaultId, bytes32 opId, address operator) external payable onlyArena {
        Vault storage v = vaults[vaultId];
        if (v.status != Status.Open) revert BadStatus();
        if (block.timestamp >= v.deadline) revert Expired();
        if (msg.value != v.fee) revert WrongFee();
        if (opConsumed[opId]) revert Replay();
        opConsumed[opId] = true;

        uint256 c = (msg.value * ownerBps) / 10_000;
        uint256 a = (msg.value * arenaBps) / 10_000;
        uint256 p = msg.value - c - a; // pot absorbs rounding dust; the three always sum to the fee

        ownerBalance[v.owner] += c;
        arenaBalance += a;
        v.pot += p;
        v.streak += 1;
        emit AttemptRecorded(vaultId, opId, operator, c, p, a, v.pot, v.streak);
    }

    /// @notice An op breached the guard: pay pot + this op's fee to the Operator.
    /// @dev Requires msg.value == fee, so a recon op (which paid nothing) can never be released.
    function release(uint256 vaultId, address operator, bytes32 transcriptHash, bytes32 opId, bytes calldata sig)
        external
        payable
        onlyArena
    {
        Vault storage v = vaults[vaultId];
        if (v.status != Status.Open) revert BadStatus();
        if (msg.value != v.fee) revert WrongFee();
        if (operator == address(0)) revert BadArgs();
        if (opConsumed[opId]) revert Replay();
        opConsumed[opId] = true;

        bytes32 structHash = keccak256(abi.encode(RELEASE_TYPEHASH, vaultId, operator, transcriptHash, opId));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        if (_recover(digest, sig) != verifier) revert BadSignature();

        uint256 amount = v.pot + msg.value;
        v.pot = 0;
        v.status = Status.Breached;
        (bool ok,) = payable(operator).call{value: amount}("");
        if (!ok) revert PayFailed();
        emit Breached(vaultId, opId, operator, transcriptHash, amount);
    }

    /// @notice Close a vault that was not breached and return the pot to its Owner.
    ///         Expired: after the deadline, by the Owner or the arena.
    ///         OrdersChanged: any time, arena only (auto-close when the guard's prompt hash changes).
    ///         OwnerClosed: any time, arena only. The Owner asks through the arena's owner-authenticated
    ///         close route, which refuses while a verified breach is waiting to be paid; a direct Owner
    ///         call could otherwise front-run the arena's release and take back a pot an operator already won.
    /// @dev In-flight ops' fees were never forwarded here; the arena refunds them off chain.
    function closeVault(uint256 vaultId, CloseReason reason) external {
        Vault storage v = vaults[vaultId];
        if (v.status != Status.Open) revert BadStatus();
        if (reason == CloseReason.Expired) {
            if (block.timestamp < v.deadline) revert NotExpired();
            if (msg.sender != v.owner && msg.sender != arena) revert NotAllowed();
        } else {
            // OrdersChanged and OwnerClosed
            if (msg.sender != arena) revert NotArena();
        }
        uint256 refund = v.pot;
        v.pot = 0;
        v.status = Status.Closed;
        (bool ok,) = payable(v.owner).call{value: refund}("");
        if (!ok) revert PayFailed();
        emit VaultClosed(vaultId, refund, reason);
    }

    /// @notice Owners withdraw their earnings from ops their guard held.
    function withdraw() external {
        uint256 b = ownerBalance[msg.sender];
        ownerBalance[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: b}("");
        if (!ok) revert PayFailed();
        emit Withdrawn(msg.sender, b);
    }

    function withdrawArena() external onlyArena {
        uint256 b = arenaBalance;
        arenaBalance = 0;
        (bool ok,) = payable(arena).call{value: b}("");
        if (!ok) revert PayFailed();
        emit Withdrawn(arena, b);
    }

    function getVault(uint256 vaultId) external view returns (Vault memory) {
        return vaults[vaultId];
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        // EIP-2: reject malleable high-s signatures
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
