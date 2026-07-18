import { spawn } from "node:child_process";
import process from "node:process";

const child = spawn(process.execPath, [
  "--import", "tsx", "--test", "packages/agent-runtime/src/release-scenarios.test.ts",
], { cwd: process.cwd(), env: { ...process.env, TSX_TSCONFIG_PATH: `${process.cwd()}/tsconfig.tests.json` }, stdio: "inherit" });

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = code ?? 1;
});
