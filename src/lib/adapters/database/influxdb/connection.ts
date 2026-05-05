import { InfluxDBConfig } from "@/lib/adapters/definitions";
import { logger } from "@/lib/logging/logger";
import { DatabaseInfo } from "@/lib/core/interfaces";

const log = logger.child({ service: "influxdb-connection" });

export function buildBaseUrl(config: InfluxDBConfig): string {
    const protocol = config.ssl ? "https" : "http";
    return `${protocol}://${config.host}:${config.port}`;
}

export async function test(
    config: InfluxDBConfig
): Promise<{ success: boolean; message: string; version?: string }> {
    const baseUrl = buildBaseUrl(config);

    try {
        if (config.version === "1") {
            // InfluxDB v1: GET /ping returns 204 with X-Influxdb-Version header
            const response = await fetch(`${baseUrl}/ping`, {
                method: "GET",
                signal: AbortSignal.timeout(10000),
            });

            if (response.status === 204 || response.status === 200) {
                const version =
                    response.headers.get("X-Influxdb-Version") ||
                    response.headers.get("x-influxdb-version") ||
                    "1.x";
                return { success: true, message: "Connection successful", version };
            }

            return {
                success: false,
                message: `Ping returned HTTP ${response.status}`,
            };
        } else {
            // InfluxDB v2: GET /health returns JSON {status: "pass", version: "..."}
            const headers: Record<string, string> = {};
            if (config.token) {
                headers["Authorization"] = `Token ${config.token}`;
            }

            const response = await fetch(`${baseUrl}/health`, {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(10000),
            });

            if (response.ok) {
                const body = (await response.json()) as {
                    version?: string;
                    status?: string;
                };
                if (body.status && body.status !== "pass") {
                    return {
                        success: false,
                        message: `InfluxDB health status: ${body.status}`,
                    };
                }
                const version = body.version || "2.x";
                return { success: true, message: "Connection successful", version };
            }

            const text = await response.text();
            return {
                success: false,
                message: `Health check failed (HTTP ${response.status}): ${text}`,
            };
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, message: `Connection failed: ${message}` };
    }
}

export async function getDatabases(config: InfluxDBConfig): Promise<string[]> {
    const baseUrl = buildBaseUrl(config);

    try {
        if (config.version === "1") {
            // InfluxDB v1: GET /query?q=SHOW+DATABASES
            const url = new URL(`${baseUrl}/query`);
            url.searchParams.set("q", "SHOW DATABASES");

            const headers: Record<string, string> = {};
            if (config.username && config.password) {
                const creds = Buffer.from(
                    `${config.username}:${config.password}`
                ).toString("base64");
                headers["Authorization"] = `Basic ${creds}`;
            }

            const response = await fetch(url.toString(), {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(10000),
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${text}`);
            }

            const body = (await response.json()) as {
                results?: Array<{
                    series?: Array<{
                        name: string;
                        columns: string[];
                        values?: string[][];
                    }>;
                }>;
            };

            const series = body?.results?.[0]?.series?.[0];
            if (!series?.values) return [];

            const nameIdx = series.columns.indexOf("name");
            const systemDbs = ["_internal"];
            return series.values
                .map((row) => row[nameIdx])
                .filter((name) => Boolean(name) && !systemDbs.includes(name));
        } else {
            // InfluxDB v2: GET /api/v2/buckets
            const headers: Record<string, string> = {};
            if (config.token) {
                headers["Authorization"] = `Token ${config.token}`;
            }

            const url = new URL(`${baseUrl}/api/v2/buckets`);
            if (config.organization) {
                url.searchParams.set("org", config.organization);
            }

            const response = await fetch(url.toString(), {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(10000),
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${text}`);
            }

            const body = (await response.json()) as {
                buckets?: Array<{ name: string; type?: string }>;
            };

            const systemBuckets = ["_monitoring", "_tasks"];
            return (body.buckets ?? [])
                .filter(
                    (b) => !systemBuckets.includes(b.name) && b.type !== "system"
                )
                .map((b) => b.name);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("getDatabases failed", {}, new Error(message));
        throw new Error(`Failed to list databases: ${message}`);
    }
}

export async function getDatabasesWithStats(
    config: InfluxDBConfig
): Promise<DatabaseInfo[]> {
    const names = await getDatabases(config);
    return names.map((name) => ({ name }));
}
