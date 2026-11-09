#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const help = `Usage: entity-tracker generate --input <json-or-url> --output <folder>

Input and output paths resolve from the current directory, including tsconfig aliases.
Configure the backend at runtime with useEntityTracker.
Options accept --flag=value or --flag value. Use --help to show this message.`;

try {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) {
    console.log(help);
  } else {
    if (args.shift() !== "generate") throw new Error('Expected command "generate".');
    const flags = {};
    while (args.length) {
      const arg = args.shift();
      const match = /^--(input|output)(?:=(.*))?$/.exec(arg);
      if (!match) throw new Error(`Unknown argument: ${arg}`);
      const [, key, inline] = match;
      if (Object.hasOwn(flags, key)) throw new Error(`Duplicate option --${key}.`);
      const value = inline ?? args.shift();
      if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value.`);
      flags[key] = value;
    }
    for (const key of ["input", "output"]) {
      if (!flags[key]) throw new Error(`Missing required option --${key}.`);
    }
    const require = createRequire(import.meta.url);
    const typesynth = resolve(
      dirname(require.resolve("typesynth/package.json")),
      "dist/bin/cli.js",
    );
    const sources = fileURLToPath(new URL("../src/generation/", import.meta.url));
    let temporary;
    try {
      if (/^https?:\/\//i.test(flags.input)) {
        const response = await fetch(flags.input);
        if (!response.ok) throw new Error(`Failed to fetch spec: HTTP ${response.status}`);
        const text = await response.text();
        JSON.parse(text);
        temporary = await mkdtemp(resolve(tmpdir(), "entity-tracker-"));
        flags.input = resolve(temporary, "spec.json");
        await writeFile(flags.input, text);
      }
      const child = spawn(
        process.execPath,
        [
          typesynth,
          "generate",
          `--sources=${sources}`,
          `--input=${flags.input}`,
          `--output=${flags.output}`,
        ],
        {
          stdio: "inherit",
        },
      );
      process.exitCode = await new Promise((done, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => done(code ?? 1));
      });
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
