import { DatabaseAdapter } from "@/lib/core/interfaces";
import { InfluxDBSchema } from "@/lib/adapters/definitions";
import { dump } from "./dump";
import { restore, prepareRestore } from "./restore";
import { test, getDatabases, getDatabasesWithStats } from "./connection";
import { analyzeDump } from "./analyze";

export const InfluxDBAdapter: DatabaseAdapter = {
    id: "influxdb",
    type: "database",
    name: "InfluxDB",
    configSchema: InfluxDBSchema,
    // No credential profile slot: v1 uses inline username/password,
    // v2 uses an inline API token. Both are encrypted by the system key.
    dump,
    restore,
    prepareRestore,
    test,
    getDatabases,
    getDatabasesWithStats,
    analyzeDump,
};
