import { describe, it, expect, vi, beforeEach } from "vitest";
import { InfluxDBConfig } from "@/lib/adapters/definitions";

// --- Hoisted mocks ---

const {
    mockFetch,
} = vi.hoisted(() => {
    return {
        mockFetch: vi.fn(),
    };
});

vi.stubGlobal("fetch", mockFetch);

import { test, getDatabases } from "@/lib/adapters/database/influxdb/connection";

function buildConfig(overrides: Partial<InfluxDBConfig> = {}): InfluxDBConfig {
    return {
        version: "2",
        host: "localhost",
        port: 8086,
        ssl: false,
        database: "",
        bucket: "",
        rpcPort: 8088,
        ...overrides,
    };
}

function mockResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
) {
    const headersMap = new Headers(headers);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: (key: string) => headersMap.get(key),
        },
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
    };
}

describe("InfluxDB connection - test()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("InfluxDB v2", () => {
        it("returns success when health status is pass", async () => {
            const config = buildConfig({ version: "2", token: "my-token" });
            mockFetch.mockResolvedValueOnce(
                mockResponse(200, { status: "pass", version: "2.7.1" })
            );

            const result = await test(config);

            expect(result.success).toBe(true);
            expect(result.version).toBe("2.7.1");
            expect(mockFetch).toHaveBeenCalledWith(
                "http://localhost:8086/health",
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: "Token my-token",
                    }),
                })
            );
        });

        it("returns failure when health status is not pass", async () => {
            const config = buildConfig({ version: "2" });
            mockFetch.mockResolvedValueOnce(
                mockResponse(200, { status: "fail", version: "2.7.1" })
            );

            const result = await test(config);

            expect(result.success).toBe(false);
            expect(result.message).toContain("fail");
        });

        it("returns failure on non-ok HTTP response", async () => {
            const config = buildConfig({ version: "2" });
            mockFetch.mockResolvedValueOnce(mockResponse(503, { message: "unavailable" }));

            const result = await test(config);

            expect(result.success).toBe(false);
            expect(result.message).toContain("503");
        });

        it("returns failure on fetch error", async () => {
            const config = buildConfig({ version: "2" });
            mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

            const result = await test(config);

            expect(result.success).toBe(false);
            expect(result.message).toContain("ECONNREFUSED");
        });

        it("uses https when ssl is true", async () => {
            const config = buildConfig({ version: "2", ssl: true });
            mockFetch.mockResolvedValueOnce(
                mockResponse(200, { status: "pass", version: "2.7.1" })
            );

            await test(config);

            expect(mockFetch).toHaveBeenCalledWith(
                "https://localhost:8086/health",
                expect.anything()
            );
        });
    });

    describe("InfluxDB v1", () => {
        it("returns success on HTTP 204 with version header", async () => {
            const config = buildConfig({ version: "1" });
            mockFetch.mockResolvedValueOnce({
                status: 204,
                headers: {
                    get: (key: string) =>
                        key === "X-Influxdb-Version" ? "1.8.10" : null,
                },
            });

            const result = await test(config);

            expect(result.success).toBe(true);
            expect(result.version).toBe("1.8.10");
            expect(mockFetch).toHaveBeenCalledWith(
                "http://localhost:8086/ping",
                expect.anything()
            );
        });

        it("returns success on HTTP 200 with fallback version", async () => {
            const config = buildConfig({ version: "1" });
            mockFetch.mockResolvedValueOnce({
                status: 200,
                headers: { get: () => null },
            });

            const result = await test(config);

            expect(result.success).toBe(true);
            expect(result.version).toBe("1.x");
        });

        it("returns failure for non-204/200 status", async () => {
            const config = buildConfig({ version: "1" });
            mockFetch.mockResolvedValueOnce({
                status: 500,
                headers: { get: () => null },
            });

            const result = await test(config);

            expect(result.success).toBe(false);
            expect(result.message).toContain("500");
        });
    });
});

describe("InfluxDB connection - getDatabases()", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("InfluxDB v2", () => {
        it("returns bucket names excluding system buckets", async () => {
            const config = buildConfig({ version: "2", token: "my-token" });
            mockFetch.mockResolvedValueOnce(
                mockResponse(200, {
                    buckets: [
                        { name: "app-data", type: "user" },
                        { name: "metrics", type: "user" },
                        { name: "_monitoring", type: "system" },
                        { name: "_tasks", type: "system" },
                    ],
                })
            );

            const result = await getDatabases(config);

            expect(result).toEqual(["app-data", "metrics"]);
        });

        it("includes org parameter when organization is set", async () => {
            const config = buildConfig({
                version: "2",
                token: "tok",
                organization: "myorg",
            });
            mockFetch.mockResolvedValueOnce(
                mockResponse(200, { buckets: [] })
            );

            await getDatabases(config);

            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining("org=myorg"),
                expect.anything()
            );
        });

        it("throws on HTTP error", async () => {
            const config = buildConfig({ version: "2" });
            mockFetch.mockResolvedValueOnce(mockResponse(401, { message: "Unauthorized" }));

            await expect(getDatabases(config)).rejects.toThrow("401");
        });
    });

    describe("InfluxDB v1", () => {
        it("returns database names excluding _internal", async () => {
            const config = buildConfig({ version: "1" });
            mockFetch.mockResolvedValueOnce(
                mockResponse(200, {
                    results: [
                        {
                            series: [
                                {
                                    name: "databases",
                                    columns: ["name"],
                                    values: [["testdb"], ["metrics"], ["_internal"]],
                                },
                            ],
                        },
                    ],
                })
            );

            const result = await getDatabases(config);

            expect(result).toEqual(["testdb", "metrics"]);
        });

        it("sends Basic auth header when username and password set", async () => {
            const config = buildConfig({
                version: "1",
                username: "admin",
                password: "secret",
            });
            mockFetch.mockResolvedValueOnce(
                mockResponse(200, { results: [{}] })
            );

            await getDatabases(config);

            const call = mockFetch.mock.calls[0];
            const headers = call[1].headers as Record<string, string>;
            expect(headers["Authorization"]).toMatch(/^Basic /);
        });

        it("returns empty array when series is missing", async () => {
            const config = buildConfig({ version: "1" });
            mockFetch.mockResolvedValueOnce(
                mockResponse(200, { results: [{}] })
            );

            const result = await getDatabases(config);

            expect(result).toEqual([]);
        });
    });
});
