import { describe, expect, it } from "vitest";
import { encodeAbiParameters, hashTypedData, keccak256, recoverTypedDataAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEV_VERIFIER_KEY, rawEcdsaKey, releaseTypedData, opIdToBytes32, signRelease, verifierAddress } from "./releaseSig";
import { stubEvmAddress, toLongZero } from "./mirror";

const vault = "0x5e1e6e0000000000000000000000000000000001" as const;
const operator = "0x00000000000000000000000000000000000004d2" as const;
const transcriptHash = keccak256(toBytes("transcript"));

const td = () => releaseTypedData({ chainId: 296, vault, vaultId: BigInt(3), operator, transcriptHash, opId: "siege_abc" });

describe("releaseSig", () => {
  it("dev verifier is anvil #1 in stub mode", () => {
    expect(verifierAddress()).toBe(privateKeyToAccount(DEV_VERIFIER_KEY).address);
    expect(verifierAddress()).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  });

  it("opIdToBytes32 = keccak256(utf8 id)", () => {
    expect(opIdToBytes32("siege_abc")).toBe(keccak256(toBytes("siege_abc")));
    expect(td().message.opId).toBe(opIdToBytes32("siege_abc"));
  });

  it("sign with DEV key recovers verifierAddress()", async () => {
    const sig = await privateKeyToAccount(DEV_VERIFIER_KEY).signTypedData(td());
    expect(await recoverTypedDataAddress({ ...td(), signature: sig })).toBe(verifierAddress());
    const sig2 = await signRelease(td());
    expect(await recoverTypedDataAddress({ ...td(), signature: sig2 })).toBe(verifierAddress());
  });

  it("digest matches the contract's manual EIP-712 encoding", () => {
    const typeHash = keccak256(toBytes("Release(uint256 vaultId,address operator,bytes32 transcriptHash,bytes32 opId)"));
    const domainHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(toBytes("SiegeVault")),
          keccak256(toBytes("2")),
          BigInt(296),
          vault,
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
        [typeHash, BigInt(3), operator, transcriptHash, opIdToBytes32("siege_abc")],
      ),
    );
    const digest = keccak256(`0x1901${domainHash.slice(2)}${structHash.slice(2)}`);
    expect(hashTypedData(td())).toBe(digest);
  });

  it("a different signer or message does not recover the verifier", async () => {
    const other = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const bad = await other.signTypedData(td());
    expect(await recoverTypedDataAddress({ ...td(), signature: bad })).not.toBe(verifierAddress());
  });

  it("parses raw and DER ECDSA keys", () => {
    const raw = DEV_VERIFIER_KEY.slice(2);
    expect(rawEcdsaKey(raw)).toBe(DEV_VERIFIER_KEY);
    expect(rawEcdsaKey(`3030020100300706052b8104000a04220420${raw}`)).toBe(DEV_VERIFIER_KEY);
    expect(() => rawEcdsaKey("nope")).toThrow();
  });

  it("address helpers", () => {
    expect(toLongZero("0.0.1234")).toBe("0x00000000000000000000000000000000000004d2");
    expect(stubEvmAddress("0.0.stub-agent-1")).toBe(stubEvmAddress("0.0.stub-agent-1"));
    expect(stubEvmAddress("0.0.stub-agent-1")).not.toBe(stubEvmAddress("0.0.stub-agent-2"));
  });
});
