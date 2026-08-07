import {defineConfig} from "vitest/config";

export default defineConfig({
    test: {
        fileParallelism: false,
        maxWorkers: 1,
        minWorkers: 1,
        projects: [
            {
                test: {
                    name: "unit",
                    include: ["tests/**/*.test.mjs"],
                    exclude: ["tests/**/*.integration.test.mjs"],
                    testTimeout: 60_000,
                },
            },
            {
                test: {
                    name: "integration",
                    include: ["tests/**/*.integration.test.mjs"],
                    testTimeout: 30_000,
                },
            },
        ],
    },
});
