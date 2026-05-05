import { describe, it, expect } from "vitest";
import { InfluxDBAdapter } from "@/lib/adapters/database/influxdb";

describe("InfluxDB Adapter - index", () => {
    it("has correct id and type", () => {
        expect(InfluxDBAdapter.id).toBe("influxdb");
        expect(InfluxDBAdapter.type).toBe("database");
        expect(InfluxDBAdapter.name).toBe("InfluxDB");
    });

    it("exposes all required DatabaseAdapter methods", () => {
        expect(typeof InfluxDBAdapter.dump).toBe("function");
        expect(typeof InfluxDBAdapter.restore).toBe("function");
        expect(typeof InfluxDBAdapter.test).toBe("function");
        expect(typeof InfluxDBAdapter.getDatabases).toBe("function");
        expect(typeof InfluxDBAdapter.getDatabasesWithStats).toBe("function");
        expect(typeof InfluxDBAdapter.prepareRestore).toBe("function");
        expect(typeof InfluxDBAdapter.analyzeDump).toBe("function");
    });

    it("configSchema parses valid v2 config with defaults", () => {
        const result = InfluxDBAdapter.configSchema.parse({
            version: "2",
            host: "influx.example.com",
            port: 8086,
            token: "my-token",
            organization: "myorg",
        });

        expect(result.version).toBe("2");
        expect(result.host).toBe("influx.example.com");
        expect(result.ssl).toBe(false);
        expect(result.rpcPort).toBe(8088);
    });

    it("configSchema parses valid v1 config with defaults", () => {
        const result = InfluxDBAdapter.configSchema.parse({
            version: "1",
            host: "influx.example.com",
            username: "admin",
            password: "secret",
            database: "mydb",
        });

        expect(result.version).toBe("1");
        expect(result.port).toBe(8086);
        expect(result.rpcPort).toBe(8088);
    });

    it("configSchema uses version 2 as default", () => {
        const result = InfluxDBAdapter.configSchema.parse({});

        expect(result.version).toBe("2");
        expect(result.host).toBe("localhost");
        expect(result.port).toBe(8086);
    });

    it("does not require a credential profile slot", () => {
        expect(InfluxDBAdapter.credentials).toBeUndefined();
    });
});
