#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {runResourceBenchmark} from "../lib/resource-benchmark.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${JSON.stringify({error: {code: "benchmark_failed", message: error.message}})}\n`);
        process.exitCode = 20;
    });
}

async function main(argv) {
    const args = parseArgs(argv);
    const report = await runResourceBenchmark({
        iterations: args.iterations,
        entries: args.entries,
        urls: args.urls
    });
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), {recursive: true});
        fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(argv) {
    const result = {iterations: 30, entries: 500, urls: 100};
    const options = new Set(["iterations", "entries", "urls", "output"]);
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
        const name = token.slice(2);
        if (!options.has(name)) throw new Error(`unknown option --${name}`);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`option --${name} requires a value`);
        result[name] = name === "output" ? value : Number(value);
        index += 1;
    }
    return result;
}
