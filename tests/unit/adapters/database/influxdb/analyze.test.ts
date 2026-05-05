import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";
import { pack } from "tar-stream";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import fs from "fs/promises";

/**
 * Build a minimal DBackup InfluxDB archive on disk with dbackup-meta.json
 * and a fake backup/ file, then analyze it.
 */
async function buildTestArchive(meta: object, tmpDir: string): Promise<string> {
    const archivePath = path.join(tmpDir, "influx_test.tar");
    const tarPack = pack();
    const outStream = createWriteStream(archivePath);
    const pipePromise = pipeline(tarPack, outStream);

    // dbackup-meta.json
    const metaBuf = Buffer.from(JSON.stringify(meta), "utf-8");
    const metaEntry = tarPack.entry({ name: "dbackup-meta.json", size: metaBuf.length });
    metaEntry.end(metaBuf);

    // Fake backup file
    const fakeBuf = Buffer.from("fake-influx-backup-data", "utf-8");
    const fakeEntry = tarPack.entry({ name: "backup/manifest.json", size: fakeBuf.length });
    fakeEntry.end(fakeBuf);

    tarPack.finalize();
    await pipePromise;

    return archivePath;
}

describe("InfluxDB Analyze - analyzeDump()", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "influx-analyze-"));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it("returns database names from v2 meta", async () => {
        const meta = {
            influxVersion: "2",
            databases: ["app-metrics", "telemetry"],
            createdAt: new Date().toISOString(),
        };
        const archivePath = await buildTestArchive(meta, tmpDir);

        const { analyzeDump } = await import(
            "@/lib/adapters/database/influxdb/analyze"
        );
        const result = await analyzeDump(archivePath);

        expect(result).toEqual(["app-metrics", "telemetry"]);
    });

    it("returns database names from v1 meta", async () => {
        const meta = {
            influxVersion: "1",
            databases: ["testdb", "metrics"],
            createdAt: new Date().toISOString(),
        };
        const archivePath = await buildTestArchive(meta, tmpDir);

        const { analyzeDump } = await import(
            "@/lib/adapters/database/influxdb/analyze"
        );
        const result = await analyzeDump(archivePath);

        expect(result).toEqual(["testdb", "metrics"]);
    });

    it("returns empty array when meta has no databases field", async () => {
        const meta = { influxVersion: "2", createdAt: "" };
        const archivePath = await buildTestArchive(meta, tmpDir);

        const { analyzeDump } = await import(
            "@/lib/adapters/database/influxdb/analyze"
        );
        const result = await analyzeDump(archivePath);

        expect(result).toEqual([]);
    });

    it("returns empty array for archive with no dbackup-meta.json", async () => {
        // Build archive with only a backup file and no meta
        const archivePath = path.join(tmpDir, "no_meta.tar");
        const tarPack = pack();
        const outStream = createWriteStream(archivePath);
        const pipePromise = pipeline(tarPack, outStream);

        const fakeBuf = Buffer.from("data", "utf-8");
        const entry = tarPack.entry({ name: "backup/some.file", size: fakeBuf.length });
        entry.end(fakeBuf);

        tarPack.finalize();
        await pipePromise;

        const { analyzeDump } = await import(
            "@/lib/adapters/database/influxdb/analyze"
        );
        const result = await analyzeDump(archivePath);

        expect(result).toEqual([]);
    });
});
