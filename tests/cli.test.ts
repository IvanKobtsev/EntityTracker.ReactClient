import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { expect, it } from "vite-plus/test";

const run = promisify(execFile);
const cli = resolve("bin/entity-tracker.mjs");
const spec = {
  version: 3,
  types: ["Note"],
  payloads: {},
  entities: { Note: { payloadType: null, payloadNullable: true } },
  eventMetadata: null,
};
it("validates CLI arguments", async () => {
  for (const args of [
    ["wrong"],
    ["generate"],
    ["generate", "--input"],
    ["generate", "--wat=x"],
    ["generate", "--input=a", "--input=b"],
  ])
    await expect(run(process.execPath, [cli, ...args])).rejects.toThrow();
  expect((await run(process.execPath, [cli, "--help"])).stdout).toContain(
    "entity-tracker generate",
  );
});
it("generates deterministic files from local and HTTP inputs and preserves unrelated files", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "entity-tracker-test-"));
  const server = createServer((request, response) => {
    if (request.url === "/missing") {
      response.writeHead(404);
      response.end();
    } else response.end(JSON.stringify(spec));
  });
  try {
    const input = resolve(directory, "input.json");
    const output = resolve(directory, "output with spaces");
    await writeFile(input, JSON.stringify(spec));
    await run(process.execPath, [cli, "generate", "--input", input, "--output", output]);
    const first = await readFile(resolve(output, "contracts.ts"), "utf8");
    await writeFile(resolve(output, "keep.txt"), "keep");
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const url = `http://127.0.0.1:${address.port}`;
    await run(process.execPath, [cli, "generate", `--input=${url}`, `--output=${output}`]);
    expect(await readFile(resolve(output, "contracts.ts"), "utf8")).toBe(first);
    expect(await readFile(resolve(output, "keep.txt"), "utf8")).toBe("keep");
    await expect(
      run(process.execPath, [cli, "generate", `--input=${url}/missing`, `--output=${output}`]),
    ).rejects.toThrow();
    await writeFile(input, JSON.stringify({ ...spec, version: 2 }));
    await expect(
      run(process.execPath, [cli, "generate", `--input=${input}`, `--output=${output}`]),
    ).rejects.toThrow();
    expect(await readFile(resolve(output, "contracts.ts"), "utf8")).toBe(first);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
