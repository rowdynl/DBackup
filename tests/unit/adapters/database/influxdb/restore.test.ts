import { describe, it, expect, vi, beforeEach } from "vitest";
import { InfluxDBConfig } from "@/lib/adapters/definitions";

// --- Hoisted mocks ---

const {
    mockExtractResult,
    mockFsMkdir,
    mockFsRm,
    mockFsReadFile,
    mockFsWriteFile,
    mockSpawnProcess,
    mockWaitForProcess,
    mockCreateReadStream,
    PassThrough,
} = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PassThrough } = require("stream") as {
        PassThrough: typeof import("stream").PassThrough;
    };

    return {
        mockExtractResult: vi.fn(),
        mockFsMkdir: vi.fn().mockResolvedValue(undefined),
        mockFsRm: vi.fn().mockResolvedValue(undefined),
        mockFsReadFile: vi.fn(),
        mockFsWriteFile: vi.fn().mockResolvedValue(undefined),
        mockSpawnProcess: vi.fn(),
        mockWaitForProcess: vi.fn(),
        mockCreateReadStream: vi.fn(),
        PassThrough,
    };
});

vi.mock("child_process", () => ({
    spawn: (...args: unknown[]) => mockSpawnProcess(...args),
}));

vi.mock("@/lib/adapters/process", () => ({
    waitForProcess: (...args: unknown[]) => mockWaitForProcess(...args),
}));

vi.mock("fs/promises", () => ({
    default: {
        mkdir: (...args: unknown[]) => mockFsMkdir(...args),
        rm: (...args: unknown[]) => mockFsRm(...args),
        readFile: (...args: unknown[]) => mockFsReadFile(...args),
        writeFile: (...args: unknown[]) => mockFsWriteFile(...args),
    },
    mkdir: (...args: unknown[]) => mockFsMkdir(...args),
    rm: (...args: unknown[]) => mockFsRm(...args),
    readFile: (...args: unknown[]) => mockFsReadFile(...args),
    writeFile: (...args: unknown[]) => mockFsWriteFile(...args),
}));

// Mock the tar extraction so we can control what files are "extracted"
vi.mock("tar-stream", () => ({
    extract: () => mockExtractResult(),
}));

vi.mock("fs", () => ({
    default: { createReadStream: (...args: unknown[]) => mockCreateReadStream(...args) },
    createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
}));

import { restore } from "@/lib/adapters/database/influxdb/restore";

function buildConfig(overrides: Partial<InfluxDBConfig> = {}): InfluxDBConfig {
    return {
        version: "2",
        host: "localhost",
        port: 8086,
        ssl: false,
        token: "my-token",
        organization: "myorg",
        bucket: "",
        database: "",
        rpcPort: 8088,
        ...overrides,
    };
}

function makeSpawnProcess() {
    const proc = new PassThrough() as unknown as ReturnType<typeof mockSpawnProcess>;
    (proc as unknown as Record<string, unknown>).stderr = new PassThrough();
    return proc;
}

/**
 * Create a mock tar extractor that emits a dbackup-meta.json entry
 * and a backup/manifest.json entry, then finishes.
 */
function makeMockExtractor(
    meta: object,
    extraFiles: Array<{ name: string; content: string }> = []
) {
    const emitter = new PassThrough();
    const entryHandlers: Array<(header: unknown, stream: unknown, next: unknown) => void> = [];
    const finishHandlers: (() => void)[] = [];
    const errorHandlers: ((err: unknown) => void)[] = [];

    const extractor = {
        on: (event: string, handler: unknown) => {
            if (event === "entry") entryHandlers.push(handler as typeof entryHandlers[0]);
            if (event === "finish") finishHandlers.push(handler as () => void);
            if (event === "error") errorHandlers.push(handler as (err: unknown) => void);
            return extractor;
        },
        pipe: () => {
            // Emit the meta entry
            const emitEntry = (name: string, content: string, nextFn: () => void) => {
                const stream = new PassThrough();
                const chunks: Buffer[] = [];
                const entryObj = {
                    on: (ev: string, fn: unknown) => {
                        if (ev === "data")
                            stream.on("data", fn as (chunk: Buffer) => void);
                        if (ev === "end")
                            stream.on("end", fn as () => void);
                        if (ev === "error")
                            stream.on("error", fn as (err: unknown) => void);
                        return entryObj;
                    },
                    resume: () => stream.resume(),
                };

                setTimeout(() => {
                    for (const handler of entryHandlers) {
                        handler({ name }, entryObj, nextFn);
                    }
                    stream.push(Buffer.from(content, "utf-8"));
                    stream.push(null);
                }, 0);
            };

            const allEntries = [
                { name: "dbackup-meta.json", content: JSON.stringify(meta) },
                ...extraFiles.map((f) => ({ name: `backup/${f.name}`, content: f.content })),
            ];

            let idx = 0;
            const next = () => {
                idx++;
                if (idx < allEntries.length) {
                    emitEntry(allEntries[idx].name, allEntries[idx].content, next);
                } else {
                    setTimeout(() => finishHandlers.forEach((h) => h()), 0);
                }
            };

            if (allEntries.length > 0) {
                emitEntry(allEntries[0].name, allEntries[0].content, next);
            } else {
                setTimeout(() => finishHandlers.forEach((h) => h()), 0);
            }
        },
    };

    mockCreateReadStream.mockReturnValue(emitter);
    emitter.pipe = extractor.pipe as unknown as typeof emitter.pipe;

    return extractor;
}

describe("InfluxDB Restore - restore()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockWaitForProcess.mockResolvedValue(undefined);
        mockFsMkdir.mockResolvedValue(undefined);
        mockFsRm.mockResolvedValue(undefined);
        mockFsWriteFile.mockResolvedValue(undefined);
        mockFsReadFile.mockResolvedValue(JSON.stringify({ databases: [] }));

        const proc = makeSpawnProcess();
        mockSpawnProcess.mockReturnValue(proc);
    });

    describe("InfluxDB v2", () => {
        it("calls influx restore with correct args", async () => {
            const config = buildConfig({ version: "2", token: "tok" });
            const meta = { influxVersion: "2", databases: ["mybucket"], createdAt: "" };

            mockExtractResult.mockReturnValue(
                makeMockExtractor(meta, [{ name: "manifest.json", content: "{}" }])
            );

            const result = await restore(config, "/tmp/backup.tar");

            expect(result.success).toBe(true);
            expect(mockSpawnProcess).toHaveBeenCalledWith(
                "influx",
                expect.arrayContaining(["restore"])
            );
        });

        it("masks token in logs", async () => {
            const config = buildConfig({ version: "2", token: "s3cr3t-tok" });
            const meta = { influxVersion: "2", databases: ["bucket"], createdAt: "" };
            const logs: string[] = [];

            mockExtractResult.mockReturnValue(
                makeMockExtractor(meta, [{ name: "manifest.json", content: "{}" }])
            );

            await restore(config, "/tmp/backup.tar", (msg) => logs.push(msg));

            const commandLog = logs.find((l) => l.includes("Running:"));
            expect(commandLog).not.toContain("s3cr3t-tok");

            const spawnArgs: string[] = mockSpawnProcess.mock.calls[0][1];
            expect(spawnArgs).toContain("s3cr3t-tok");
        });

        it("uses https when ssl is true", async () => {
            const config = buildConfig({ version: "2", ssl: true });
            const meta = { influxVersion: "2", databases: [], createdAt: "" };

            mockExtractResult.mockReturnValue(
                makeMockExtractor(meta, [{ name: "manifest.json", content: "{}" }])
            );

            await restore(config, "/tmp/backup.tar");

            const spawnArgs: string[] = mockSpawnProcess.mock.calls[0][1];
            const hostArg = spawnArgs[spawnArgs.indexOf("--host") + 1];
            expect(hostArg).toMatch(/^https:\/\//);
        });
    });

    describe("InfluxDB v1", () => {
        it("calls influxd restore with -portable", async () => {
            const config = buildConfig({ version: "1", host: "influxhost", rpcPort: 8088 });
            const meta = { influxVersion: "1", databases: ["mydb"], createdAt: "" };

            mockFsReadFile.mockResolvedValue(
                JSON.stringify({ databases: [{ name: "mydb" }] })
            );
            mockExtractResult.mockReturnValue(
                makeMockExtractor(meta, [{ name: "manifest.json", content: "{}" }])
            );

            const result = await restore(config, "/tmp/v1_backup.tar");

            expect(result.success).toBe(true);
            expect(mockSpawnProcess).toHaveBeenCalledWith(
                "influxd",
                expect.arrayContaining(["restore", "-portable"])
            );

            const spawnArgs: string[] = mockSpawnProcess.mock.calls[0][1];
            const hostIdx = spawnArgs.indexOf("-host");
            expect(spawnArgs[hostIdx + 1]).toBe("influxhost:8088");
        });

        it("adds -newdb when targetDatabaseName differs", async () => {
            const config = buildConfig({
                version: "1",
                targetDatabaseName: "restored-db",
            } as InfluxDBConfig & { targetDatabaseName: string });

            const meta = { influxVersion: "1", databases: ["original-db"], createdAt: "" };
            mockFsReadFile.mockResolvedValue(
                JSON.stringify({ databases: [{ name: "original-db" }] })
            );
            mockExtractResult.mockReturnValue(
                makeMockExtractor(meta, [{ name: "manifest.json", content: "{}" }])
            );

            await restore(config, "/tmp/v1.tar");

            const spawnArgs: string[] = mockSpawnProcess.mock.calls[0][1];
            expect(spawnArgs).toContain("-database");
            expect(spawnArgs).toContain("original-db");
            expect(spawnArgs).toContain("-newdb");
            expect(spawnArgs).toContain("restored-db");
        });
    });

    it("returns failure when no backup files found", async () => {
        const config = buildConfig({ version: "2" });
        const meta = { influxVersion: "2", databases: [], createdAt: "" };

        // No extra files - only meta entry
        mockExtractResult.mockReturnValue(makeMockExtractor(meta, []));

        const result = await restore(config, "/tmp/empty.tar");

        expect(result.success).toBe(false);
        expect(result.error).toContain("No backup files");
    });

    it("cleans up temp dir even on failure", async () => {
        const config = buildConfig({ version: "2" });
        mockExtractResult.mockReturnValue(makeMockExtractor({}, []));

        await restore(config, "/tmp/bad.tar");

        expect(mockFsRm).toHaveBeenCalledWith(
            expect.stringContaining("influx_restore_"),
            { recursive: true, force: true }
        );
    });
});
