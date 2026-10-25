import assert from "node:assert/strict";
import test from "node:test";
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, id, parseEther, type InterfaceAbi } from "ethers";
import { compileVault, compileWusdt } from "./lib/fleet";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import solc from "solc";
import { keccak256 } from "ethers";
import { DeploymentJournal, sha256 } from "./lib/deployment-journal";
import { DeploymentSteps } from "./lib/deployment-steps";
import { currentFee, type DeploymentNetwork } from "./lib/deployment-network";

test("deployment steps execute and resume on a real EVM, including pinned CREATE2", { timeout: 90_000 }, async () => {
  const url = process.env.CONTRACT_TEST_RPC;
  assert.ok(url, "CONTRACT_TEST_RPC must name a disposable Anvil");
  assert.match(new URL(url).hostname, /^(localhost|127\.0\.0\.1|anvil-[a-z-]+)$/);
  const p = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
  p.pollingInterval = 50;
  try {
    assert.equal((await p.getNetwork()).chainId, 31337n);
    for (const deterministic of [false, true]) {
      const owner = Wallet.createRandom().connect(p);
      await p.send("anvil_setBalance", [owner.address, `0x${parseEther("100").toString(16)}`]);
      let create2;
      if (deterministic) {
        // Disposable test fixture for the documented salt || init-code protocol.
        const source = "pragma solidity ^0.8.24; contract TestFactory { fallback() external { assembly { let size := sub(calldatasize(),32) calldatacopy(0,32,size) let deployed := create2(0,0,size,calldataload(0)) if iszero(deployed) { revert(0,0) } } } }";
        const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "TestFactory.sol": { content: source } }, settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
        const artifact = output.contracts["TestFactory.sol"].TestFactory;
        const factory = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, new NonceManager(owner)).deploy();
        await factory.waitForDeployment();
        const address = await factory.getAddress();
        create2 = { address, codeHash: keccak256(await p.getCode(address)), salt: id("test-only-create2") };
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wusdt-evm-resume-"));
      let store = new DeploymentJournal(directory, sha256(`test:${deterministic}`));
      try {
        const network = { chain: "ethereum", provider: p, urls: [url], fee: await currentFee(p), gasBudget: 15_000_000n } as DeploymentNetwork;
        const runner = new DeploymentSteps(network, owner, store, 1, 10_000);
        if (create2) await assert.rejects(runner.deploy("bad-factory", compileWusdt(), ["Wrapped USDT", "wUSDT", 6, owner.address], { ...create2, codeHash: id("wrong-code") }));
        const args = ["Wrapped USDT", "wUSDT", 6, owner.address];
        const token = await runner.deploy("token", compileWusdt(), args, create2);
        // Simulate a process restart between token and vault deployment.
        store.close();
        store = new DeploymentJournal(directory, sha256(`test:${deterministic}`));
        const resumed = new DeploymentSteps(network, owner, store, 1, 10_000);
        assert.equal(await resumed.deploy("token", compileWusdt(), args, create2), token);
        const vault = await resumed.deploy("vault", compileVault(), [token, owner.address, 6], create2);
        const tokenContract = new Contract(token, compileWusdt().abi as InterfaceAbi, p);
        const data = tokenContract.interface.encodeFunctionData("setMinter", [vault]);
        await resumed.transaction("minter", { to: token, data });
        const nonce = await p.getTransactionCount(owner.address);
        await resumed.transaction("minter", { to: token, data });
        assert.equal(await p.getTransactionCount(owner.address), nonce, "retries must not create another transaction");
        assert.equal(await tokenContract.minter(), vault);
        assert.ok(store.chain("ethereum").steps.minter.confirmed);
      } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
    }
  } finally { p.destroy(); }
});

/** Dedicated disposable Anvil only. Never point this test at a platform/mainnet node. */
test("enhanced reserve contracts: roles, replay, dust, capacity, pause, redemption and governance", { timeout: 90_000 }, async () => {
  const url = process.env.CONTRACT_TEST_RPC;
  assert.ok(url, "CONTRACT_TEST_RPC must name a dedicated disposable Anvil on chain 31337");
  assert.match(new URL(url).hostname, /^(localhost|127\.0\.0\.1|anvil-[a-z-]+)$/);
  const p = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
  p.pollingInterval = 50;
  try {
    assert.equal((await p.getNetwork()).chainId, 31337n, "refusing to mutate any non-test chain");
    for (const decimals of [6, 18]) {
      const admin = Wallet.createRandom().connect(p);
      const holder = Wallet.createRandom().connect(p);
      const successor = Wallet.createRandom().connect(p);
      for (const signer of [admin, holder, successor]) await p.send("anvil_setBalance", [signer.address, `0x${parseEther("100").toString(16)}`]);
      const signer = new NonceManager(admin);
      const tokenArtifact = compileWusdt();
      const vaultArtifact = compileVault();
      const tokenBase = await new ContractFactory(tokenArtifact.abi as InterfaceAbi, tokenArtifact.bytecode, signer).deploy("Wrapped USDT", "wUSDT", decimals, admin.address);
      await tokenBase.waitForDeployment();
      const token = new Contract(await tokenBase.getAddress(), tokenArtifact.abi as InterfaceAbi, signer);
      const vaultBase = await new ContractFactory(vaultArtifact.abi as InterfaceAbi, vaultArtifact.bytecode, signer).deploy(await token.getAddress(), admin.address, decimals);
      await vaultBase.waitForDeployment();
      const vault = new Contract(await vaultBase.getAddress(), vaultArtifact.abi as InterfaceAbi, signer);
      const vaultAddress = await vault.getAddress();
      assert.equal(await token.decimals(), BigInt(decimals));
      assert.equal(await vault.maxReserve(), 10_000_000n * 10n ** BigInt(decimals));
      await assert.rejects(token.setMinter.staticCall(holder.address));
      await (await token.setMinter(vaultAddress)).wait();
      await (await vault.grantRole(id("BRIDGE_ROLE"), admin.address)).wait();
      await (await vault.grantRole(id("OPERATOR_ROLE"), admin.address)).wait();
      await assert.rejects(token.mint.staticCall(holder.address, 1));
      const outsider = vault.connect(holder) as Contract;
      await assert.rejects(outsider.injectNetReserve.staticCall(id("not-allowed"), 1));
      await assert.rejects(outsider.distributeToAppWallets.staticCall([holder.address]));
      const message = id(`test:${decimals}`);
      await (await vault.injectNetReserve(message, 1_000_001n)).wait();
      await assert.rejects(vault.injectNetReserve.staticCall(message, 1));
      await assert.rejects(vault.injectNetReserve.staticCall(id("over-cap"), await vault.maxReserve()));
      await assert.rejects(vault.injectNetReserve.staticCall(id("zero"), 0));
      await assert.rejects(vault.distributeToAppWallets.staticCall([]));
      await assert.rejects(vault.distributeToAppWallets.staticCall(Array.from({ length: 201 }, () => holder.address)));
      await assert.rejects(vault.distributeToAppWallets.staticCall([vaultAddress]));
      const recipients = [holder.address, successor.address, Wallet.createRandom().address];
      await (await vault.distributeToAppWallets(recipients)).wait();
      for (const recipient of recipients) assert.equal(await token.balanceOf(recipient), 83_333n);
      assert.equal(await vault.currentReserve(), 750_002n, "unsplittable dust stays accounted for");
      assert.equal(await vault.reserveDrift(), 0n);
      await (await vault.pause()).wait();
      await assert.rejects(vault.injectNetReserve.staticCall(id("paused"), 1));
      await assert.rejects(vault.releaseReserve.staticCall(holder.address, 1));
      await (await vault.unpause()).wait();
      await (await token.pause()).wait();
      const holderToken = token.connect(holder) as Contract;
      await assert.rejects(holderToken.transfer.staticCall(admin.address, 1));
      await assert.rejects(holderToken.requestRedemption.staticCall(1));
      await (await token.unpause()).wait();
      const requestId = await holderToken.requestRedemption.staticCall(100);
      await (await holderToken.requestRedemption(100)).wait();
      assert.equal(await token.totalSupply(), 999_901n);
      await (await vault.confirmRedemption(requestId, holder.address, 100)).wait();
      await assert.rejects(vault.confirmRedemption.staticCall(requestId, holder.address, 100));
      assert.equal(await vault.currentReserve(), 749_902n);
      assert.equal(await vault.reserveDrift(), 0n);
      await (await vault.releaseReserve(holder.address, 100)).wait();
      assert.equal(await vault.currentReserve(), 749_802n);
      assert.equal(await vault.reserveDrift(), 0n);
      await (await token.setGovernor(admin.address)).wait();
      await (await vault.setGovernor(admin.address)).wait();
      assert.ok(await token.hasRole(id("ADMIN_ROLE"), admin.address));
      assert.ok(await vault.hasRole(id("ADMIN_ROLE"), admin.address));
      await assert.rejects(token.grantRole.staticCall(id("MINTER_ROLE"), holder.address));
      const secondBase = await new ContractFactory(vaultArtifact.abi as InterfaceAbi, vaultArtifact.bytecode, signer).deploy(await token.getAddress(), admin.address, decimals);
      await secondBase.waitForDeployment();
      const second = await secondBase.getAddress();
      await (await token.grantRole(id("MINTER_ROLE"), second)).wait();
      assert.equal(await token.minter(), second);
      assert.equal(await token.hasRole(id("MINTER_ROLE"), vaultAddress), false);
      assert.equal(await token.hasRole(id("MINTER_ROLE"), second), true);
      await (await token.setGovernor(successor.address)).wait();
      await (await vault.setGovernor(successor.address)).wait();
      for (const contract of [token, vault]) {
        assert.equal(await contract.governor(), successor.address);
        assert.equal(await contract.hasRole(id("ADMIN_ROLE"), admin.address), false);
        assert.equal(await contract.hasRole(id("PAUSER_ROLE"), admin.address), false);
      }
    }
  } finally { p.destroy(); }
});
