import { describe, it, expect, vi, beforeEach } from "vitest";
import { InfluxDBConfig } from "@/lib/adapters/definitions";

// --- Hoisted mocks ---

const {
    mockGetDatabases,
    mockFsStat,
    mockFsMkdir,
    mockFsRm,
    mockFsReaddir,
    mockFsReadFile,
    mockSpawnProcess,
    mockWaitForProcess,
    mockPipelinePromise,
    mockPackEntry,
    mockPackFinalize,
    mockCreateWriteStream,
    mockCreateReadStream,
    PassThrough,
} = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PassThrough } = require("stream") as {
        PassThrough: typeof import("stream").PassThrough;
    };

    const mockPackFinalize = vi.fn();
    const mockPackEntry = vi.fn((opts: object, cb?: (err: unknown) => void) => {
        const stream = new PassThrough();
        if (cb) process.nextTick(cb, null);
        return stream;
    });

    return {
        mockGetDatabases: vi.fn(),
        mockFsStat: vi.fn(),
        mockFsMkdir: vi.fn().mockResolvedValue(undefined),
        mockFsRm: vi.fn().mockResolvedValue(undefined),
        mockFsReaddir: vi.fn(),
        mockFsReadFile: vi.fn(),
        mockSpawnProcess: vi.fn(),
        mockWaitForProcess: vi.fn(),
        mockPipelinePromise: vi.fn().mockResolvedValue(undefined),
        mockPackEntry,
        mockPackFinalize,
        mockCreateWriteStream: vi.fn(),
        mockCreateReadStream: vi.fn(),
        PassThrough,
    };
});

vi.mock("@/lib/adapters/database/influxdb/connection", () => ({
    getDatabases: (...args: unknown[]) => mockGetDatabases(...args),
    buildBaseUrl: vi.fn(),
}));

vi.mock("child_process", () => ({
    spawn: (...args: unknown[]) => mockSpawnProcess(...args),
}));

vi.mock("@/lib/adapters/process", () => ({
    waitForProcess: (...args: unknown[]) => mockWaitForProcess(...args),
}));

vi.mock("stream/promises", () => ({
    pipeline: (...args: unknown[]) => mockPipelinePromise(...args),
}));

vi.mock("tar-stream", () => ({
    pack: () => ({
        entry: (...args: unknown[]) => mockPackEntry(...args),
        finalize: () => mockPackFinalize(),
        pipe: vi.fn(),
    }),
}));

vi.mock("fs", () => {
    const stream = new PassThrough();
    const writeStreamMock = vi.fn(() => {
        const ws = new PassThrough() as unknown;
        return ws;
    });
    const readStreamMock = vi.fn(() => stream);
    return {
        default: { createWriteStream: writeStreamMock, createReadStream: readStreamMock },
        createWriteStream: (...args: unknown[]) => mockCreateWriteStream(...args),
        createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
    };
});

vi.mock("fs/promises", () => ({
    default: {
        stat: (...args: unknown[]) => mockFsStat(...args),
        mkdir: (...args: unknown[]) => mockFsMkdir(...args),
        rm: (...args: unknown[]) => mockFsRm(...args),
        readdir: (...args: unknown[]) => mockFsReaddir(...args),
        readFile: (...args: unknown[]) => mockFsReadFile(...args),
    },
    stat: (...args: unknown[]) => mockFsStat(...args),
    mkdir: (...args: unknown[]) => mockFsMkdir(...args),
    rm: (...args: unknown[]) => mockFsRm(...args),
    readdir: (...args: unknown[]) => mockFsReaddir(...args),
    readFile: (...args: unknown[]) => mockFsReadFile(...args),
}));

import { dump } from "@/lib/adapters/database/influxdb/dump";

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
    (proc as unknown as Record<string, unknown>).stdin = new PassThrough();
    (proc as unknown as Record<string, unknown>).stdout = new PassThrough();
    (proc as unknown as Record<string, unknown>).kill = vi.fn();
    return proc;
}

describe("InfluxDB Dump - dump()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockWaitForProcess.mockResolvedValue(undefined);
        mockFsStat.mockResolvedValue({ size: 65536 });
        mockFsRm.mockResolvedValue(undefined);
        mockFsMkdir.mockResolvedValue(undefined);
        // collectFiles: readdir returns no files by default
        mockFsReaddir.mockResolvedValue([]);
        mockPipelinePromise.mockResolvedValue(undefined);
        const proc = makeSpawnProcess();
        mockSpawnProcess.mockReturnValue(proc);

        const entryStream = new PassThrough();
        mockPackEntry.mockReturnValue(entryStream);
    });

    describe("InfluxDB v2", () => {
        it("runs influx backup and returns success", async () => {
            const config = buildConfig({ version: "2", bucket: "" });

            const result = await dump(config, "/tmp/influx_backup.tar");

            expect(result.success).toBe(true);
            expect(result.size).toBe(65536);
            expect(mockSpawnProcess).toHaveBeenCalledWith(
                "influx",
                expect.arrayContaining(["backup"])
            );
        });

        it("passes --token flag and masks it in logs", async () => {
            const config = buildConfig({ version: "2", token: "secret-token" });
            const logs: string[] = [];

            await dump(config, "/tmp/out.tar", (msg) => logs.push(msg));

            const commandLog = logs.find((l) => l.includes("Running:"));
            expect(commandLog).toBeDefined();
            expect(commandLog).not.toContain("secret-token");

            const spawnArgs: string[] = mockSpawnProcess.mock.calls[0][1];
            expect(spawnArgs).toContain("secret-token");
        });

        it("passes --bucket when bucket is specified", async () => {
            const config = buildConfig({ version: "2", bucket: "telemetry" });

            await dump(config, "/tmp/out.tar");

            const spawnArgs: string[] = mockSpawnProcess.mock.calls[0][1];
            expect(spawnArgs).toContain("--bucket");
            expect(spawnArgs).toContain("telemetry");
        });

        it("runs once per bucket for multiple buckets", async () => {
            const config = buildConfig({
                version: "2",
                bucket: ["bucket-a", "bucket-b"],
            });

            await dump(config, "/tmp/out.tar");

            expect(mockSpawnProcess).toHaveBeenCalledTimes(2);
        });

        it("uses https when ssl is true", async () => {
            const config = buildConfig({ version: "2", ssl: true });

            await dump(config, "/tmp/out.tar");

            const spawnArgs: string[] = mockSpawnProcess.mock.calls[0][1];
            const hostArg = spawnArgs[spawnArgs.indexOf("--host") + 1];
            expect(hostArg).toMatch(/^https:\/\//);
        });

        it("returns failure when spawn throws", async () => {
            const config = buildConfig({ version: "2" });
            mockWaitForProcess.mockRejectedValueOnce(new Error("influx not found"));

            const result = await dump(config, "/tmp/out.tar");

            expect(result.success).toBe(false);
            expect(result.error).toContain("influx not found");
        });
    });

    describe("InfluxDB v1", () => {
        it("runs influxd backup with -portable and returns success", async () => {
            const config = buildConfig({
                version: "1",
                database: "mydb",
                username: "admin",
                password: "secret",
            });

            const result = await dump(config, "/tmp/influx_v1.tar");

            expect(result.success).toBe(true);
            expect(mockSpawnProcess).toHaveBeenCalledWith(
                "influxd",
                expect.arrayContaining(["backup", "-portable"])
            );
        });

        it("passes -database flag for specific database", async () => {
            const config = buildConfig({ version: "1", database: "testdb" });

            await dump(config, "/tmp/out.tar");

            const spawnArgs: string[] = mockSpawnProcess.mock.calls[0][1];
            expect(spawnArgs).toContain("-database");
            expect(spawnArgs).toContain("testdb");
        });

        it("masks password in logs", async () => {
            const config = buildConfig({
                version: "1",
                database: "mydb",
                password: "s3cr3t",
            });
            const logs: string[] = [];

            await dump(config, "/tmp/out.tar", (msg) => logs.push(msg));

            const commandLog = logs.find((l) => l.includes("Running:"));
            expect(commandLog).not.toContain("s3cr3t");

            const spawnArgs: string[] = mockSpawnProcess.mock.calls[0][1];
            expect(spawnArgs).toContain("s3cr3t");
        });

        it("uses RPC host with rpcPort", async () => {
            const config = buildConfig({
                version: "1",
                database: "mydb",
                host: "influxhost",
                rpcPort: 9999,
            });

            await dump(config, "/tmp/out.tar");

            const spawnArgs: string[] = mockSpawnProcess.mock.calls[0][1];
            const hostIdx = spawnArgs.indexOf("-host");
            expect(spawnArgs[hostIdx + 1]).toBe("influxhost:9999");
        });

        it("queries all databases when none selected", async () => {
            const config = buildConfig({ version: "1", database: "" });
            mockGetDatabases.mockResolvedValueOnce(["db1", "db2"]);
            mockFsReadFile.mockResolvedValue(
                JSON.stringify({
                    databases: [{ name: "db1" }, { name: "db2" }],
                })
            );

            await dump(config, "/tmp/out.tar");

            expect(mockSpawnProcess).toHaveBeenCalledTimes(2);
        });
    });
});
