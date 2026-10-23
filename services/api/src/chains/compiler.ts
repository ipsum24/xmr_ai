import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { config } from "../config";

export interface CompiledContract {
  name: string;
  abi: readonly unknown[];
  bytecode: string;
}

export type ContractBundle = Record<string, CompiledContract>;

let cache: ContractBundle | null = null;

/**
 * Compile the contracts from the repo's own Solidity sources with solc, at boot.
 * Nothing is pre-baked: the bytecode deployed to a devnet chain is compiled from
 * the source files in this checkout, so edits take effect on the next restart.
 */
export function compileContracts(): ContractBundle {
  if (cache) return cache;

  const dir = path.resolve(config.contractsDir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sol"));
  if (files.length === 0) throw new Error(`no Solidity sources found in ${dir}`);

  const sources: Record<string, { content: string }> = {};
  for (const file of files) sources[file] = { content: fs.readFileSync(path.join(dir, file), "utf8") };

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error(`solc failed:\n${errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n")}`);
  }

  const bundle: ContractBundle = {};
  for (const contracts of Object.values<Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>>(
    output.contracts ?? {},
  )) {
    for (const [name, contract] of Object.entries(contracts)) {
      const bytecode = contract.evm.bytecode.object;
      if (!bytecode) continue; // interface-only sources compile to no bytecode
      bundle[name] = { name, abi: contract.abi, bytecode: `0x${bytecode}` };
    }
  }

  cache = bundle;
  return bundle;
}
