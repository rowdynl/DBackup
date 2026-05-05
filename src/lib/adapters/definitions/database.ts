import { z } from "zod";
import { safePath, safePathRegex, safeBinaryPath, sshFields } from "./shared";

export const MySQLSchema = z.object({
    host: z.string().default("localhost"),
    port: z.coerce.number().default(3306),
    user: z.string().min(1, "User is required"),
    password: z.string().optional(),
    database: z.union([z.string(), z.array(z.string())]).default(""),
    options: z.string().optional().describe("Additional mysqldump options"),
    disableSsl: z.boolean().default(false).describe("Disable SSL (Use for self-signed development DBs)"),
    ...sshFields,
});

export const MariaDBSchema = z.object({
    host: z.string().default("localhost"),
    port: z.coerce.number().default(3306),
    user: z.string().min(1, "User is required"),
    password: z.string().optional(),
    database: z.union([z.string(), z.array(z.string())]).default(""),
    options: z.string().optional().describe("Additional mariadb-dump options"),
    disableSsl: z.boolean().default(false).describe("Disable SSL (Use for self-signed development DBs)"),
    ...sshFields,
});

export const PostgresSchema = z.object({
    host: z.string().default("localhost"),
    port: z.coerce.number().default(5432),
    user: z.string().min(1, "User is required"),
    password: z.string().optional(),
    database: z.union([z.string(), z.array(z.string())]).default(""),
    options: z.string().optional().describe("Additional pg_dump options"),
    ...sshFields,
});

export const MongoDBSchema = z.object({
    uri: z.string().optional().describe("Connection URI (overrides other settings)"),
    host: z.string().default("localhost"),
    port: z.coerce.number().default(27017),
    user: z.string().optional(),
    password: z.string().optional(),
    authenticationDatabase: z.string().default("admin").optional(),
    database: z.union([z.string(), z.array(z.string())]).default(""),
    options: z.string().optional().describe("Additional mongodump options"),
    ...sshFields,
});

export const SQLiteSchema = z.object({
    mode: z.enum(["local", "ssh"]).describe("Connection Mode"),

    // Common
    path: safePath("Database path").describe("Absolute path to .sqlite file"),
    sqliteBinaryPath: safeBinaryPath.default("sqlite3").optional().describe("Path to sqlite3 binary (default: sqlite3)"),

    // SSH Specific
    host: z.string().optional().describe("SSH Host (Required for SSH mode)"),
    port: z.coerce.number().default(22).optional(),
    username: z.string().optional().describe("SSH Username"),
    authType: z.enum(["password", "privateKey", "agent"]).default("password").optional().describe("Authentication Method"),
    password: z.string().optional().describe("SSH Password"),
    privateKey: z.string().optional().describe("SSH Private Key"),
    passphrase: z.string().optional().describe("SSH Key Passphrase"),
});

export const MSSQLSchema = z.object({
    host: z.string().default("localhost"),
    port: z.coerce.number().default(1433),
    user: z.string().min(1, "User is required"),
    password: z.string().optional(),
    database: z.union([z.string(), z.array(z.string())]).default(""),
    encrypt: z.boolean().default(true).describe("Encrypt connection (required for Azure SQL)"),
    trustServerCertificate: z.boolean().default(false).describe("Trust self-signed certificates (for development)"),
    backupPath: z.string().regex(safePathRegex, "Backup path contains invalid characters").default("/var/opt/mssql/backup").describe("Server-side path where SQL Server writes .bak files"),
    fileTransferMode: z.enum(["local", "ssh"]).default("local").describe("How to access .bak files from the SQL Server"),
    localBackupPath: z.string().default("/tmp").optional().describe("Host-side path (Docker volume mount or shared filesystem)"),
    sshHost: z.string().optional().describe("SSH host of the SQL Server (defaults to DB host)"),
    sshPort: z.coerce.number().default(22).optional().describe("SSH port"),
    sshUsername: z.string().optional().describe("SSH username"),
    sshAuthType: z.enum(["password", "privateKey", "agent"]).default("password").optional().describe("SSH authentication method"),
    sshPassword: z.string().optional().describe("SSH password"),
    sshPrivateKey: z.string().optional().describe("SSH private key (PEM format)"),
    sshPassphrase: z.string().optional().describe("Passphrase for SSH private key"),
    requestTimeout: z.coerce.number().default(300000).describe("Request timeout in ms (default: 5 minutes, increase for large databases)"),
    options: z.string().optional().describe("Additional backup options"),
});

export const RedisSchema = z.object({
    mode: z.enum(["standalone", "sentinel"]).default("standalone").describe("Connection mode"),
    host: z.string().default("localhost"),
    port: z.coerce.number().default(6379),
    username: z.string().optional().describe("Username (Redis 6+ ACL, leave empty for default)"),
    password: z.string().optional(),
    database: z.coerce.number().min(0).max(15).default(0).describe("Database index (0-15)"),
    tls: z.boolean().default(false).describe("Enable TLS/SSL connection"),
    sentinelMasterName: z.string().optional().describe("Master name for Sentinel mode"),
    sentinelNodes: z.string().optional().describe("Comma-separated sentinel nodes (host:port,host:port)"),
    options: z.string().optional().describe("Additional redis-cli options"),
    ...sshFields,
});

export const InfluxDBSchema = z.object({
    version: z.enum(["1", "2"]).default("2").describe("InfluxDB major version"),
    host: z.string().default("localhost"),
    port: z.coerce.number().default(8086).describe("HTTP API port"),
    ssl: z.boolean().default(false).describe("Use HTTPS"),

    // InfluxDB v1 fields
    username: z.string().optional().describe("Username (v1 only)"),
    password: z.string().optional().describe("Password (v1 only)"),
    database: z
        .union([z.string(), z.array(z.string())])
        .default("")
        .describe("Database(s) to backup (v1 only, leave empty to backup all)"),
    rpcPort: z.coerce
        .number()
        .default(8088)
        .describe("RPC service port used by influxd backup/restore (v1 only, default: 8088)"),

    // InfluxDB v2 fields
    token: z.string().optional().describe("API token (v2 only)"),
    organization: z.string().optional().describe("Organization name (v2 only)"),
    bucket: z
        .union([z.string(), z.array(z.string())])
        .default("")
        .describe("Bucket(s) to backup (v2 only, leave empty to backup all)"),

    options: z.string().optional().describe("Additional CLI options"),
});

// Inferred TypeScript Types
export type MySQLConfig = z.infer<typeof MySQLSchema>;
export type MariaDBConfig = z.infer<typeof MariaDBSchema>;
export type PostgresConfig = z.infer<typeof PostgresSchema>;
export type MongoDBConfig = z.infer<typeof MongoDBSchema>;
export type SQLiteConfig = z.infer<typeof SQLiteSchema>;
export type MSSQLConfig = z.infer<typeof MSSQLSchema>;
export type RedisConfig = z.infer<typeof RedisSchema>;
export type InfluxDBConfig = z.infer<typeof InfluxDBSchema>;

export type DatabaseConfig = MySQLConfig | MariaDBConfig | PostgresConfig | MongoDBConfig | SQLiteConfig | MSSQLConfig | RedisConfig | InfluxDBConfig;

// Generic type alias for dialect base class (accepts any database config)
export type AnyDatabaseConfig = DatabaseConfig;
