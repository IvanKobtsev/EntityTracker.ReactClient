import { describe, expect, it } from "vite-plus/test";
import { renderContracts, validateSpec } from "../src/generation/spec.ts";
import ts from "typescript";

const fixture = {
  version: 3,
  types: ["Note", "Empty", "odd-name"],
  payloads: {
    NotePayload: {
      properties: [
        { name: "odd-key", type: "string | null | undefined" },
        { name: "children", type: "NotePayload[]" },
        { name: "values", type: 'Record<string, "a" | "b">' },
      ],
    },
    Metadata: { properties: [{ name: "userId", type: "string" }] },
  },
  entities: {
    Note: { payloadType: "NotePayload", payloadNullable: true },
    Empty: { payloadType: null, payloadNullable: true },
    "odd-name": { payloadType: null, payloadNullable: false },
  },
  eventMetadata: { type: "Metadata", nullable: true },
};
describe("specification", () => {
  it("preserves expressions, names and metadata deterministically", () => {
    validateSpec(fixture);
    const source = renderContracts(fixture);
    expect(source).toContain('"odd-key": string | null | undefined');
    expect(source).toContain('"Note": NotePayload | null');
    expect(source).toContain('"Empty": null');
    expect(source).toContain("EventMetadata = Metadata | null");
    expect(source).toBe(renderContracts(fixture));
    const fileName = "/generated.ts";
    const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ESNext, types: [] };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) =>
      name === fileName
        ? ts.createSourceFile(name, source, version, true)
        : original(name, version, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([fileName], options, host);
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toEqual([]);
  });
  it("supports no metadata", () => {
    const spec = { ...fixture, eventMetadata: null };
    validateSpec(spec);
    expect(renderContracts(spec)).toContain("EventMetadata = null");
  });
  it.each([
    { ...fixture, version: 2 },
    { ...fixture, types: ["Note", "Note"] },
    { ...fixture, entities: {} },
    { ...fixture, eventMetadata: { type: "Missing", nullable: true } },
  ])("rejects incompatible input", (spec) => expect(() => validateSpec(spec)).toThrow());
});
