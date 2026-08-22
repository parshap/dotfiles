#!/usr/bin/env node
import process from "node:process";
import { apply, explain, printLayers, register, status, unregister } from "./compositor.js";

function usage() {
  console.error("Usage: dotfiles-layer <register NAME PATH|unregister NAME|layers|explain [TARGET]|status [TARGET]|diff [TARGET]|apply [TARGET] [--adopt] [--force]>");
}

export function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "register": if (args.length !== 2) return usage(), 2; register(args[0], args[1]); break;
    case "unregister": if (args.length !== 1) return usage(), 2; unregister(args[0]); break;
    case "layers": if (args.length) return usage(), 2; printLayers(); break;
    case "explain": if (args.length > 1) return usage(), 2; explain(args[0]); break;
    case "status":
    case "check": // backwards-compatible alias for status
    case "diff": if (args.length > 1) return usage(), 2; status(args[0], command === "diff"); break;
    case "apply": {
      let targetId;
      const options = { adopt: false, force: false };
      for (const arg of args) {
        if (arg === "--adopt") options.adopt = true;
        else if (arg === "--force") options.force = true;
        else if (!targetId) targetId = arg;
        else return usage(), 2;
      }
      apply(targetId, options); break;
    }
    default: usage(); return 2;
  }
  return 0;
}

try {
  const code = main(process.argv.slice(2));
  if (code) process.exitCode = code;
} catch (error) {
  console.error(`dotfiles-layer: ${error.message}`);
  process.exitCode = 1;
}
