// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SiegeVault} from "../src/SiegeVault.sol";

/// @dev Minimal slice of Foundry's cheatcode interface (no forge-std needed).
interface VmScript {
    function envUint(string calldata name) external view returns (uint256);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function addr(uint256 privateKey) external pure returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// Deploy SiegeVault (Hedera testnet via Hashio, or any EVM chain).
///
///   DEPLOYER_KEY=0x<32-byte ECDSA hex> VERIFIER_ADDRESS=0x... \
///   forge script script/Deploy.s.sol --rpc-url https://testnet.hashio.io/api --broadcast --legacy --slow
///
/// arena    = the deployer (the same ECDSA key the worker uses as HEDERA_OPERATOR_KEY)
/// verifier = VERIFIER_ADDRESS (defaults to the arena address: dev only, never for a live demo)
/// bps      = FEE_SPLIT_CASTELLAN_BPS / FEE_SPLIT_POT_BPS / FEE_SPLIT_ARENA_BPS (default 8000/1500/500)
///
/// The constructor takes no value, so there is no tinybar/weibar conversion here.
contract Deploy {
    VmScript internal constant vm = VmScript(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function run() external returns (SiegeVault vault) {
        uint256 pk = vm.envUint("DEPLOYER_KEY");
        address arena = vm.addr(pk);
        address verifier = vm.envOr("VERIFIER_ADDRESS", arena);
        uint16 c = uint16(vm.envOr("FEE_SPLIT_CASTELLAN_BPS", uint256(8000)));
        uint16 p = uint16(vm.envOr("FEE_SPLIT_POT_BPS", uint256(1500)));
        uint16 a = uint16(vm.envOr("FEE_SPLIT_ARENA_BPS", uint256(500)));

        vm.startBroadcast(pk);
        vault = new SiegeVault(arena, verifier, c, p, a);
        vm.stopBroadcast();
    }
}
