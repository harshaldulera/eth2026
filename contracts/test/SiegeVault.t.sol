// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SiegeVault} from "../src/SiegeVault.sol";

/// @dev Minimal slice of Foundry's cheatcode interface, so this file compiles without
///      `forge install foundry-rs/forge-std`. Signatures match forge-std's Vm.sol.
interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
    function deal(address who, uint256 newBalance) external;
    function prank(address msgSender) external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert() external;
    function chainId(uint256 newChainId) external;
}

abstract contract MiniTest {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function assertEq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert(string.concat(what, ": ", _u(a), " != ", _u(b)));
    }

    function assertEq(address a, address b, string memory what) internal pure {
        if (a != b) revert(string.concat(what, ": address mismatch"));
    }

    function assertTrue(bool ok, string memory what) internal pure {
        if (!ok) revert(what);
    }

    function _u(uint256 x) private pure returns (string memory) {
        if (x == 0) return "0";
        bytes memory b;
        while (x != 0) {
            b = abi.encodePacked(bytes1(uint8(48 + (x % 10))), b);
            x /= 10;
        }
        return string(b);
    }
}

/// Rejects every payment (no receive / fallback).
contract Rejecter {}

contract SiegeVaultTest is MiniTest {
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant VERIFIER_PK = 0x2000000000000000000000000000000000000000000000000000000000000002;
    uint256 internal constant IMPOSTOR_PK = 0x3000000000000000000000000000000000000000000000000000000000000003;
    uint256 internal constant DAY = 1 days;

    SiegeVault internal vault;
    address internal verifier;
    address internal castellan = address(0xCA57E11A);
    address internal castellan2 = address(0xCA57E11B);
    address internal raider = address(0x5A1DE5);
    address internal raider2 = address(0x5A1DE6);
    address internal stranger = address(0x57A26E5);

    // The test contract itself is the arena.
    receive() external payable {}

    function setUp() public {
        vm.chainId(296); // Hedera testnet
        vm.warp(1_800_000_000);
        vm.deal(address(this), 1_000_000 ether);
        vm.deal(stranger, 1 ether);
        verifier = vm.addr(VERIFIER_PK);
        vault = new SiegeVault(address(this), verifier, 8000, 1500, 500);
    }

    // ------------------------------------------------------------------ helpers

    function _sid(string memory s) internal pure returns (bytes32) {
        return keccak256(bytes(s));
    }

    function _digest(uint256 vaultId, address r, bytes32 t, bytes32 siegeId) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(vault.RELEASE_TYPEHASH(), vaultId, r, t, siegeId));
        return keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 pk, uint256 vaultId, address r, bytes32 t, bytes32 siegeId) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(pk, _digest(vaultId, r, t, siegeId));
        return abi.encodePacked(rr, ss, v);
    }

    function _open(uint256 fee, uint256 pot) internal returns (uint256) {
        return vault.createVault{value: pot}(fee, uint64(DAY), castellan);
    }

    function _status(uint256 id) internal view returns (uint256) {
        return uint256(vault.getVault(id).status);
    }

    function _invariant(address[] memory cs) internal view {
        uint256 pots;
        for (uint256 i = 1; i < vault.nextVaultId(); i++) pots += vault.getVault(i).pot;
        uint256 cb;
        for (uint256 i = 0; i < cs.length; i++) cb += vault.castellanBalance(cs[i]);
        assertEq(address(vault).balance, pots + cb + vault.arenaBalance(), "invariant");
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_rejectsBpsNotSummingTo10000() public {
        vm.expectRevert(SiegeVault.BadArgs.selector);
        new SiegeVault(address(this), verifier, 8000, 1500, 499);
        vm.expectRevert(SiegeVault.BadArgs.selector);
        new SiegeVault(address(this), verifier, 60000, 15536, 0); // would wrap to 10000 in uint16
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(SiegeVault.BadArgs.selector);
        new SiegeVault(address(0), verifier, 8000, 1500, 500);
        vm.expectRevert(SiegeVault.BadArgs.selector);
        new SiegeVault(address(this), address(0), 8000, 1500, 500);
    }

    // ------------------------------------------------------------------ createVault

    function test_createVault_onlyArena() public {
        vm.prank(stranger);
        vm.expectRevert(SiegeVault.NotArena.selector);
        vault.createVault{value: 1}(1, 1, castellan);
    }

    function test_createVault_stores() public {
        uint256 id = _open(100, 5_000);
        assertEq(id, 1, "id");
        SiegeVault.Vault memory v = vault.getVault(id);
        assertEq(v.castellan, castellan, "castellan");
        assertEq(v.pot, 5_000, "pot");
        assertEq(v.fee, 100, "fee");
        assertEq(v.deadline, block.timestamp + DAY, "deadline");
        assertEq(uint256(v.status), 1, "status");
        assertEq(address(vault).balance, 5_000, "balance");
    }

    // ------------------------------------------------------------------ recordAttempt

    function test_recordAttempt_splitsOddFee() public {
        _open(12_345, 1_000_000);
        vault.recordAttempt{value: 12_345}(1, _sid("s-1"), raider);
        assertEq(vault.castellanBalance(castellan), 9_876, "castellan cut");
        assertEq(vault.arenaBalance(), 617, "arena cut");
        assertEq(vault.getVault(1).pot, 1_000_000 + 1_852, "pot");
        assertEq(vault.getVault(1).streak, 1, "streak");
        assertTrue(vault.siegeConsumed(_sid("s-1")), "consumed");
    }

    function testFuzz_recordAttempt_splitSumsToFee(uint96 fee) public {
        if (fee == 0) fee = 1;
        _open(fee, 1);
        vault.recordAttempt{value: fee}(1, _sid("f"), raider);
        uint256 c = vault.castellanBalance(castellan);
        uint256 a = vault.arenaBalance();
        uint256 p = vault.getVault(1).pot - 1;
        assertEq(c + a + p, fee, "sum");
        assertEq(c, (uint256(fee) * 8000) / 10_000, "c");
        assertEq(a, (uint256(fee) * 500) / 10_000, "a");
    }

    function test_recordAttempt_wrongFee() public {
        _open(1_000, 1);
        vm.expectRevert(SiegeVault.WrongFee.selector);
        vault.recordAttempt{value: 999}(1, _sid("s"), raider);
        vm.expectRevert(SiegeVault.WrongFee.selector);
        vault.recordAttempt{value: 0}(1, _sid("s"), raider);
    }

    function test_recordAttempt_replay() public {
        _open(1_000, 1);
        vault.recordAttempt{value: 1_000}(1, _sid("s"), raider);
        vm.expectRevert(SiegeVault.Replay.selector);
        vault.recordAttempt{value: 1_000}(1, _sid("s"), raider);
    }

    function test_recordAttempt_expired() public {
        _open(1_000, 1);
        vm.warp(block.timestamp + DAY);
        vm.expectRevert(SiegeVault.Expired.selector);
        vault.recordAttempt{value: 1_000}(1, _sid("s"), raider);
    }

    function test_recordAttempt_onlyArena() public {
        _open(1_000, 1);
        vm.deal(raider, 1_000);
        vm.prank(raider);
        vm.expectRevert(SiegeVault.NotArena.selector);
        vault.recordAttempt{value: 1_000}(1, _sid("s"), raider);
    }

    // ------------------------------------------------------------------ release

    function test_release_paysPotPlusFee() public {
        _open(1_000, 50_000);
        vault.recordAttempt{value: 1_000}(1, _sid("held"), raider2);
        bytes32 t = keccak256("transcript");
        bytes memory sig = _sign(VERIFIER_PK, 1, raider, t, _sid("broke"));
        uint256 before = raider.balance;
        vault.release{value: 1_000}(1, raider, t, _sid("broke"), sig);
        assertEq(raider.balance - before, 50_150 + 1_000, "payout");
        assertEq(_status(1), 2, "status Broken");
        assertEq(vault.getVault(1).pot, 0, "pot");
    }

    function test_release_wrongSigner() public {
        _open(1_000, 50_000);
        bytes32 t = keccak256("t");
        bytes memory sig = _sign(IMPOSTOR_PK, 1, raider, t, _sid("b"));
        vm.expectRevert(SiegeVault.BadSignature.selector);
        vault.release{value: 1_000}(1, raider, t, _sid("b"), sig);
    }

    function test_release_tamperedRaider() public {
        _open(1_000, 50_000);
        bytes32 t = keccak256("t");
        bytes memory sig = _sign(VERIFIER_PK, 1, raider, t, _sid("b"));
        vm.expectRevert(SiegeVault.BadSignature.selector);
        vault.release{value: 1_000}(1, stranger, t, _sid("b"), sig);
    }

    function test_release_tamperedTranscript() public {
        _open(1_000, 50_000);
        bytes memory sig = _sign(VERIFIER_PK, 1, raider, keccak256("t"), _sid("b"));
        vm.expectRevert(SiegeVault.BadSignature.selector);
        vault.release{value: 1_000}(1, raider, keccak256("other"), _sid("b"), sig);
    }

    function test_release_highSMalleated() public {
        _open(1_000, 50_000);
        bytes32 t = keccak256("t");
        bytes32 d = _digest(1, raider, t, _sid("b"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VERIFIER_PK, d);
        bytes32 s2 = bytes32(N - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        assertEq(ecrecover(d, v2, r, s2), verifier, "malleated sig is otherwise valid");
        vm.expectRevert(SiegeVault.BadSignature.selector);
        vault.release{value: 1_000}(1, raider, t, _sid("b"), abi.encodePacked(r, s2, v2));
    }

    function test_release_compact64ByteSig() public {
        _open(1_000, 50_000);
        bytes32 t = keccak256("t");
        (, bytes32 r, bytes32 s) = vm.sign(VERIFIER_PK, _digest(1, raider, t, _sid("b")));
        vm.expectRevert(SiegeVault.BadSignature.selector);
        vault.release{value: 1_000}(1, raider, t, _sid("b"), abi.encodePacked(r, s));
    }

    function test_release_twice() public {
        _open(1_000, 50_000);
        bytes32 t = keccak256("t");
        bytes memory sig = _sign(VERIFIER_PK, 1, raider, t, _sid("b"));
        vault.release{value: 1_000}(1, raider, t, _sid("b"), sig);
        vm.expectRevert(SiegeVault.BadStatus.selector);
        vault.release{value: 1_000}(1, raider, t, _sid("b"), sig);
        // same siege id on another vault
        _open(1_000, 50_000);
        bytes memory sig2 = _sign(VERIFIER_PK, 2, raider, t, _sid("b"));
        vm.expectRevert(SiegeVault.Replay.selector);
        vault.release{value: 1_000}(2, raider, t, _sid("b"), sig2);
    }

    function test_release_freeSiegeZeroValue() public {
        _open(1_000, 50_000);
        bytes32 t = keccak256("t");
        bytes memory sig = _sign(VERIFIER_PK, 1, raider, t, _sid("free"));
        vm.expectRevert(SiegeVault.WrongFee.selector);
        vault.release{value: 0}(1, raider, t, _sid("free"), sig);
    }

    function test_release_rejectingRaiderPayFailed() public {
        _open(1_000, 50_000);
        address rej = address(new Rejecter());
        bytes32 t = keccak256("t");
        bytes memory sig = _sign(VERIFIER_PK, 1, rej, t, _sid("b"));
        vm.expectRevert(SiegeVault.PayFailed.selector);
        vault.release{value: 1_000}(1, rej, t, _sid("b"), sig);
        assertEq(_status(1), 1, "still open");
    }

    // ------------------------------------------------------------------ closeVault / withdraw

    function test_closeVault_notExpired() public {
        _open(1_000, 50_000);
        vm.prank(castellan);
        vm.expectRevert(SiegeVault.NotExpired.selector);
        vault.closeVault(1);
    }

    function test_closeVault_stranger() public {
        _open(1_000, 50_000);
        vm.warp(block.timestamp + DAY);
        vm.prank(stranger);
        vm.expectRevert(SiegeVault.NotAllowed.selector);
        vault.closeVault(1);
    }

    function test_closeVault_refundsCastellan() public {
        _open(1_000, 50_000);
        vault.recordAttempt{value: 1_000}(1, _sid("h"), raider);
        vm.warp(block.timestamp + DAY);
        uint256 before = castellan.balance;
        vm.prank(castellan);
        vault.closeVault(1);
        assertEq(castellan.balance - before, 50_150, "refund");
        assertEq(_status(1), 3, "status Closed");
        assertEq(vault.castellanBalance(castellan), 800, "earnings kept");
    }

    function test_withdraw() public {
        _open(10_000, 1);
        vault.recordAttempt{value: 10_000}(1, _sid("h1"), raider);
        vault.recordAttempt{value: 10_000}(1, _sid("h2"), raider);
        uint256 before = castellan.balance;
        vm.prank(castellan);
        vault.withdraw();
        assertEq(castellan.balance - before, 16_000, "withdrawn");
        assertEq(vault.castellanBalance(castellan), 0, "zeroed");
    }

    function test_withdrawArena_onlyArena() public {
        _open(10_000, 1);
        vault.recordAttempt{value: 10_000}(1, _sid("h1"), raider);
        vm.prank(stranger);
        vm.expectRevert(SiegeVault.NotArena.selector);
        vault.withdrawArena();
        uint256 before = address(this).balance;
        vault.withdrawArena();
        assertEq(address(this).balance - before, 500, "arena cut");
    }

    // ------------------------------------------------------------------ invariant

    function test_invariant_mixedSequence() public {
        address[] memory cs = new address[](2);
        cs[0] = castellan;
        cs[1] = castellan2;
        _open(12_345, 100_000);
        vault.createVault{value: 50_000}(1_000, uint64(2 * DAY), castellan2);
        vault.createVault{value: 3}(777, uint64(DAY / 2), castellan);
        for (uint256 i = 0; i < 4; i++) {
            vault.recordAttempt{value: 12_345}(1, keccak256(abi.encode("a1", i)), raider);
            vault.recordAttempt{value: 1_000}(2, keccak256(abi.encode("a2", i)), raider2);
            vault.recordAttempt{value: 777}(3, keccak256(abi.encode("a3", i)), raider);
            _invariant(cs);
        }
        vm.prank(castellan);
        vault.withdraw();
        _invariant(cs);
        bytes32 t = keccak256("x");
        vault.release{value: 1_000}(2, raider, t, _sid("b2"), _sign(VERIFIER_PK, 2, raider, t, _sid("b2")));
        _invariant(cs);
        vm.warp(block.timestamp + DAY / 2);
        vm.prank(castellan);
        vault.closeVault(3);
        _invariant(cs);
        vault.withdrawArena();
        _invariant(cs);
        vault.recordAttempt{value: 12_345}(1, _sid("late"), raider);
        vm.prank(castellan2);
        vault.withdraw();
        _invariant(cs);
        assertEq(vault.arenaBalance(), 617, "arena");
        assertEq(vault.castellanBalance(castellan), 9_876, "castellan");
    }
}
