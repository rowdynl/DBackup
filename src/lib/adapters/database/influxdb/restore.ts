import { BackupResult } from "@/lib/core/interfaces";
import { LogLevel, LogType } from "@/lib/core/logs";
import { spawn } from "child_process";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { extract } from "tar-stream";
import { randomUUID } from "crypto";
import { InfluxDBConfig } from "@/lib/adapters/definitions";
import { waitForProcess } from "@/lib/adapters/process";
import type { InfluxDBBackupMeta } from "./dump";

type InfluxDBRestoreConfig = InfluxDBConfig & {
    detectedVersion?: string;
    /** Override target database/bucket name for rename during restore */
    targetDatabaseName?: string;
    privilegedAuth?: { user: string; password: string };
};

/**
 * Extract all backup/ entries from the DBackup InfluxDB tar archive.
 * Returns the embedded meta and the list of extracted file paths.
 */
async function extractBackupTar(
    sourcePath: string,
    extractDir: string
): Promise<{ meta: InfluxDBBackupMeta | null; files: string[] }> {
    await fs.mkdir(extractDir, { recursive: true });

    let meta: InfluxDBBackupMeta | null = null;
    const files: string[] = [];

    return new Promise((resolve, reject) => {
        const extractor = extract();

        extractor.on("entry", (header, stream, next) => {
            const chunks: Buffer[] = [];

            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", async () => {
                try {
                    if (header.name === "dbackup-meta.json") {
                        meta = JSON.parse(
                            Buffer.concat(chunks).toString("utf-8")
                        ) as InfluxDBBackupMeta;
                    } else if (header.name.startsWith("backup/")) {
                        const relPath = header.name.slice("backup/".length);
                        if (!relPath) {
                            next();
                            return;
                        }

                        const outPath = path.join(extractDir, relPath);

                        // Security: prevent Zip Slip
                        const resolvedOut = path.resolve(outPath);
                        const resolvedDir = path.resolve(extractDir);
                        if (!resolvedOut.startsWith(resolvedDir + path.sep)) {
                            reject(
                                new Error(`Zip Slip detected in: ${header.name}`)
                            );
                            return;
                        }

                        await fs.mkdir(path.dirname(outPath), { recursive: true });
                        await fs.writeFile(outPath, Buffer.concat(chunks));
                        files.push(outPath);
                    }

                    next();
                } catch (err) {
                    reject(err);
                }
            });

            stream.on("error", reject);
            stream.resume();
        });

        extractor.on("finish", () => resolve({ meta, files }));
        extractor.on("error", reject);

        createReadStream(sourcePath).pipe(extractor);
    });
}

/**
 * Mask sensitive values in CLI arg arrays for logging
 */
function maskArgs(
    args: string[],
    sensitiveValues: (string | undefined)[]
): string[] {
    return args.map((arg) => {
        for (const val of sensitiveValues) {
            if (!val) continue;
            if (arg === val) return "******";
            if (arg.includes(val)) return arg.replace(val, "******");
        }
        return arg;
    });
}

async function runRestoreCommand(
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
 * Read database names from the InfluxDB v1 backup manifest file
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

async function restoreV1(
    config: InfluxDBRestoreConfig,
    backupDir: string,
    log: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void
): Promise<void> {
    const rpcHost = `${config.host}:${config.rpcPort ?? 8088}`;
    const args = ["restore", "-portable", "-host", rpcHost];

    // Handle database rename when targetDatabaseName is provided
    if (config.targetDatabaseName) {
        const sourceDbs = await readV1ManifestDatabases(backupDir);
        if (sourceDbs.length === 1 && sourceDbs[0] !== config.targetDatabaseName) {
            args.push("-database", sourceDbs[0]);
            args.push("-newdb", config.targetDatabaseName);
            log(
                `Remapping database: ${sourceDbs[0]} → ${config.targetDatabaseName}`,
                "info"
            );
        }
    }

    if (config.username) args.push("-username", config.username);
    if (config.password) args.push("-password", config.password);
    if (config.options) args.push(...config.options.split(/\s+/).filter(Boolean));
    args.push(backupDir);

    await runRestoreCommand("influxd", args, [config.password], log);
}

async function restoreV2(
    config: InfluxDBRestoreConfig,
    backupDir: string,
    log: (msg: string, level?: LogLevel, type?: LogType, details?: string) => void
): Promise<void> {
    const protocol = config.ssl ? "https" : "http";
    const baseHost = `${protocol}://${config.host}:${config.port}`;

    const args = ["restore", backupDir, "--host", baseHost];
    if (config.token) args.push("--token", config.token);
    if (config.organization) args.push("--org", config.organization);

    // Handle bucket rename when targetDatabaseName is provided
    if (config.targetDatabaseName) {
        const selection =
            typeof config.bucket === "string"
                ? [config.bucket]
                : config.bucket ?? [];
        const filteredSelection = selection.filter(Boolean);
        if (
            filteredSelection.length === 1 &&
            filteredSelection[0] !== config.targetDatabaseName
        ) {
            args.push("--bucket", filteredSelection[0]);
            args.push("--new-bucket", config.targetDatabaseName);
            log(
                `Remapping bucket: ${filteredSelection[0]} → ${config.targetDatabaseName}`,
                "info"
            );
        }
    }

    if (config.options) args.push(...config.options.split(/\s+/).filter(Boolean));

    await runRestoreCommand("influx", args, [config.token], log);
}

export async function prepareRestore(
    _config: InfluxDBRestoreConfig,
    _databases: string[]
): Promise<void> {
    // No pre-flight permission checks for InfluxDB.
    // The CLI will report any permission errors during restore.
}

export async function restore(
    config: InfluxDBRestoreConfig,
    sourcePath: string,
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

    const extractDir = path.join(
        path.dirname(sourcePath),
        `influx_restore_${randomUUID()}`
    );

    try {
        log("Extracting backup archive...", "info");
        const { meta, files } = await extractBackupTar(sourcePath, extractDir);

        if (files.length === 0) {
            throw new Error("No backup files found in archive");
        }

        // Determine the InfluxDB version from meta or fall back to config
        const influxVersion = meta?.influxVersion ?? config.version;
        log(
            `Restoring InfluxDB v${influxVersion} backup (${files.length} file(s))`,
            "info"
        );

        if (influxVersion === "1") {
            await restoreV1(config, extractDir, log);
        } else {
            await restoreV2(config, extractDir, log);
        }

        log("Restore completed successfully", "success");

        return {
            success: true,
            logs,
            startedAt,
            completedAt: new Date(),
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Restore failed: ${message}`, "error");

        return {
            success: false,
            logs,
            error: message,
            startedAt,
            completedAt: new Date(),
        };
    } finally {
        await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
}
