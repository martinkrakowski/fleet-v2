// Fixture for tests/hexagen-contract.test.sh. A deliberate violation: a Node builtin imported in
// the domain layer (hexagen 0.14.0 reports it as node-builtin-in-layer). Never imported or run.
import { readFileSync } from "node:fs";

export const readStamp = (file: string): string => readFileSync(file, "utf8");
