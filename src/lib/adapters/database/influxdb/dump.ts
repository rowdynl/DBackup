import { BackupResult } from "@/lib/core/interfaces";
import { LogLevel, LogType } from "@/lib/core/logs";
import { spawn } from "child_process";
import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { pack } from "tar-stream";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { InfluxDBConfig } from "@/lib/adapters/definitions";
import { getDatabases } from "./connection";
import { waitForProcess } from "@/lib/adapters/process";

type InfluxDBDumpConfig = InfluxDBConfig & {
    detectedVersion?: string;
};

export interface InfluxDBBackupMeta {
    influxVersion: "1" | "2";
    databases: string[];
    createdAt: string;
}

/**
 * Parse the user's database/bucket selection from config value
 */
function parseSelection(value: string | string[] | undefined): string[] {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Recursively collect all files in a directory, returning abs and relative paths
 */
async function collectFiles(
    dir: string,
    base: string = dir
): Promise<Array<{ absPath: string; relPath: string }>> {
    const result: Array<{ absPath: string; relPath: string }> = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const absPath = path.join(dir, entry.name);
        const relPath = path.relative(base, absPath);

        if (entry.isDirectory()) {
            result.push(...(await collectFiles(absPath, base)));
        } else if (entry.isFile()) {
            result.push({ absPath, relPath });
        }
    }

    return result;
}

/**
 * Pack all files from a backup directory into a single TAR archive.
 * Includes a dbackup-meta.json file at the root.
 */
async function packBackupDirectory(
    backupDir: string,
    destPath: string,
    meta: InfluxDBBackupMeta
): Promise<void> {
    const tarPack = pack();
    const outputStream = createWriteStream(destPath);
    const pipelinePromise = pipeline(tarPack, outputStream);

    // Add dbackup-meta.json as first entry
    const metaBuffer = Buffer.from(JSON.stringify(meta, null, 2), "utf-8");
    const metaEntry = tarPack.entry({
        name: "dbackup-meta.json",
        size: metaBuffer.length,
    });
    metaEntry.end(metaBuffer);

    // Add all files from the backup directory under the backup/ prefix
    const allFiles = await collectFiles(backupDir);

    for (const { absPath, relPath } of allFiles) {
        const stat = await fs.stat(absPath);
        const entryName = `backup/${relPath.replace(/\\/g, "/")}`;

        const entry = tarPack.entry({
            name: entryName,
            size: stat.size,
        });

        const readStream = createReadStream(absPath);
        await new Promise<void>((resolve, reject) => {
            readStream.on("error", reject);
            readStream.on("end", () => {
                entry.end();
                resolve();
            });
            readStream.pipe(entry);
        });
    }

    tarPack.finalize();
    await pipelinePromise;
}

/**
 * Mask sensitive CLI argument values for safe logging
 */
function maskArgs(
    args: string[],
    sensitiveValues: (string | undefined)[]
): string[] {
    return args.map((arg) => {
        for (const val of sensitiveValues) {
            if (!val) continue;
            if (arg === val) return "******";
            if (arg.endsWith(`=${val}`)) return arg.replace(val, "******");
        }
        return arg;
    });
}

/**
 * Spawn a backup command and wait for completion
 */
async function runBackupCommand(
    binary: string,
    args: string[],
    sensitiveValues: (string | undefined)[],
    log: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void
): Promise<void> {
    const logArgs = maskArgs(args, sensitiveValues);
    log(`Running: ${binary} ${logArgs.join(" ")}`, "info", "command");

    const proc = spawn(binary, args);
    const stderrLines: string[] = [];

    proc.stderr?.on("data", (data) => {
        const line = (data as Buffer).toString().trim();
        if (line) stderrLines.push(line);
    });

    await waitForProcess(proc, binary);

    if (stderrLines.length > 0) {
        log(`${binary} output`, "info", "command", stderrLines.join("\n"));
    }
}

/**
 * Read database names from an InfluxDB v1 portable backup manifest
 */
async function readV1ManifestDatabases(backupDir: string): Promise<string[]> {
    const manifestPath = path.join(backupDir, "manifest.json");

    try {
        const raw = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as {
            databases?: Array<{ name: string }>;
        };
        return (manifest.databases ?? []).map((d) => d.name);
    } catch {
        return [];
    }
}

/**
 * Read bucket names from an InfluxDB v2 backup manifest
 */
async function readV2ManifestBuckets(backupDir: string): Promise<string[]> {
    const manifestPath = path.join(backupDir, "manifest.json");

    try {
        const raw = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as {
            files?: Array<{ bucketName?: string }>;
        };
        const names = new Set<string>();
        for (const f of manifest.files ?? []) {
            if (f.bucketName) names.add(f.bucketName);
        }
        return [...names];
    } catch {
        return [];
    }
}

/**
 * Run InfluxDB v1 backup using influxd backup -portable.
 *
 * For multiple databases, each database is backed up in sequence to the
 * same directory - the portable manifest accumulates entries across calls.
 * Returns the list of backed-up database names.
 */
async function dumpV1(
    config: InfluxDBDumpConfig,
    backupDir: string,
    databases: string[],
    log: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void
): Promise<string[]> {
    const rpcHost = `${config.host}:${config.rpcPort ?? 8088}`;

    const buildBaseArgs = (): string[] => {
        const args = ["backup", "-portable", "-host", rpcHost];
        if (config.username) args.push("-username", config.username);
        if (config.password) args.push("-password", config.password);
        if (config.options) args.push(...config.options.split(/\s+/).filter(Boolean));
        return args;
    };

    if (databases.length === 0) {
        // Backup all databases in one shot
        const args = [...buildBaseArgs(), backupDir];
        await runBackupCommand("influxd", args, [config.password], log);
        return readV1ManifestDatabases(backupDir);
    }

    for (const db of databases) {
        log(`Backing up database: ${db}`, "info");
        const args = [...buildBaseArgs(), "-database", db, backupDir];
        await runBackupCommand("influxd", args, [config.password], log);
    }

    return databases;
}

/**
 * Run InfluxDB v2 backup using the influx CLI.
 *
 * For multiple buckets each bucket is backed up in sequence to the same
 * directory - the v2 CLI merges all bucket files there.
 * Returns the list of backed-up bucket names.
 */
async function dumpV2(
    config: InfluxDBDumpConfig,
    backupDir: string,
    buckets: string[],
    log: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void
): Promise<string[]> {
    const protocol = config.ssl ? "https" : "http";
    const baseHost = `${protocol}://${config.host}:${config.port}`;

    const buildBaseArgs = (): string[] => {
        const args = ["backup", backupDir, "--host", baseHost];
        if (config.token) args.push("--token", config.token);
        if (config.organization) args.push("--org", config.organization);
        if (config.options) args.push(...config.options.split(/\s+/).filter(Boolean));
        return args;
    };

    if (buckets.length === 0) {
        // Backup all buckets in one shot
        const args = buildBaseArgs();
        await runBackupCommand("influx", args, [config.token], log);
        return readV2ManifestBuckets(backupDir);
    }

    for (const bucket of buckets) {
        log(`Backing up bucket: ${bucket}`, "info");
        const args = [...buildBaseArgs(), "--bucket", bucket];
        await runBackupCommand("influx", args, [config.token], log);
    }

    return buckets;
}

export async function dump(
    config: InfluxDBDumpConfig,
    destinationPath: string,
    onLog?: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void,
    _onProgress?: (percentage: number) => void
): Promise<BackupResult> {
    const startedAt = new Date();
    const logs: string[] = [];

    const log = (
        msg: string,
        level: LogLevel = "info",
        type: LogType = "general",
        details?: string
    ) => {
        logs.push(msg);
        if (onLog) onLog(msg, level, type, details);
    };

    // Temp dir lives alongside destination to avoid cross-device moves
    const backupDir = path.join(
        path.dirname(destinationPath),
        `influx_backup_${randomUUID()}`
    );

    try {
        await fs.mkdir(backupDir, { recursive: true });

        let backedUpDatabases: string[] = [];

        if (config.version === "1") {
            const selection = parseSelection(config.database);
            log(
                selection.length === 0
                    ? "Backing up all databases (InfluxDB v1)"
                    : `Backing up databases: ${selection.join(", ")} (InfluxDB v1)`,
                "info"
            );

            // When backing up all, discover names first for metadata
            const targetDbs =
                selection.length > 0
                    ? selection
                    : await getDatabases(config).catch(() => []);

            backedUpDatabases = await dumpV1(config, backupDir, targetDbs, log);
        } else {
            const selection = parseSelection(config.bucket);
            log(
                selection.length === 0
                    ? "Backing up all buckets (InfluxDB v2)"
                    : `Backing up buckets: ${selection.join(", ")} (InfluxDB v2)`,
                "info"
            );

            backedUpDatabases = await dumpV2(config, backupDir, selection, log);
        }

        log("Packing backup files into archive...", "info");

        const meta: InfluxDBBackupMeta = {
            influxVersion: config.version,
            databases: backedUpDatabases,
            createdAt: new Date().toISOString(),
        };

        await packBackupDirectory(backupDir, destinationPath, meta);

        const stats = await fs.stat(destinationPath);
        log(
            `Backup completed successfully. Archive size: ${stats.size} bytes`,
            "success"
        );

        return {
            success: true,
            path: destinationPath,
            size: stats.size,
            logs,
            startedAt,
            completedAt: new Date(),
            metadata: {
                databases: backedUpDatabases,
            },
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Backup failed: ${message}`, "error");

        return {
            success: false,
            logs,
            error: message,
            startedAt,
            completedAt: new Date(),
        };
    } finally {
        await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
}
