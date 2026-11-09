import type { GeneratorScriptProps } from "typesynth";
import { renderContracts, validateSpec } from "./spec.ts";
export default async function main({ data, generate }: GeneratorScriptProps) {
  validateSpec(data);
  const content = renderContracts(data);
  await generate("source", { content }, "./contracts.ts");
  await generate("source", { content: 'export * from "./contracts";\n' }, "./index.ts");
}
