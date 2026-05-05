# InfluxDB

Back up InfluxDB time-series databases - supports both v1 (databases) and v2 (buckets/organizations).

## Supported Versions

| Version | Notes |
| :--- | :--- |
| 1.x (1.5+) | Uses `influxd backup -portable`. Requires RPC port (default 8088). |
| 2.x | Uses `influx backup`. Requires an API token. |

DBackup wraps the native backup output in a TAR archive, which is then compressed or encrypted as configured in the backup job.

## Prerequisites

`influxd` (v1) and `influx` (v2) are bundled in the DBackup Docker image - no extra setup required.

For bare-metal installations, install the required tool on the DBackup server and ensure it is on the system `PATH`:

- **v1**: Install [InfluxDB 1.x](https://docs.influxdata.com/influxdb/v1/install/) - provides `influxd`
- **v2**: Install the [influx CLI](https://docs.influxdata.com/influxdb/v2/tools/influx-cli/) - provides `influx`

## Configuration

| Field | Description | Default | Required |
| :--- | :--- | :--- | :--- |
| **Version** | InfluxDB major version (`1` or `2`) | `2` | ✅ |
| **Host** | InfluxDB server hostname or IP | `localhost` | ✅ |
| **Port** | HTTP API port | `8086` | ✅ |
| **Use HTTPS** | Enable TLS for HTTP API calls | `false` | ❌ |
| **Username** | Username for authentication (v1 only) | - | ❌ |
| **Password** | Password for authentication (v1 only) | - | ❌ |
| **Database** | Database name(s) to backup (v1 only, leave empty to back up all) | All | ❌ |
| **RPC Port** | InfluxDB RPC service port used by `influxd backup` (v1 only) | `8088` | ❌ |
| **API Token** | InfluxDB v2 API token with read access | - | v2 ✅ |
| **Organization** | InfluxDB v2 organization name | - | ❌ |
| **Bucket** | Bucket name(s) to backup (v2 only, leave empty to back up all) | All | ❌ |
| **Additional Options** | Extra CLI flags appended to `influxd backup` / `influx backup` | - | ❌ |

::: info Credentials are stored encrypted
InfluxDB credentials (password, API token) are stored using AES-256-GCM encryption via DBackup's system encryption key. They are not stored in plain text.
:::

## Setup Guide

### InfluxDB v1

1. Navigate to **Sources** → **Add Source** → select **InfluxDB**.
2. Set **Version** to `1`.
3. Enter **Host**, **Port** (HTTP, default `8086`), and **RPC Port** (default `8088`).
4. Set **Username** and **Password** if authentication is enabled on your InfluxDB instance.
5. Enter one or more **Database** names, or leave blank to back up all databases.
6. Click **Test Connection** - DBackup will call the `/ping` endpoint.
7. Click **Fetch Databases** to list available databases.
8. Click **Save**.

### InfluxDB v2

1. Navigate to **Sources** → **Add Source** → select **InfluxDB**.
2. Set **Version** to `2` (default).
3. Enter **Host** and **Port** (HTTP API, default `8086`).
4. Enter an **API Token** with sufficient read and backup permissions.
5. Enter your **Organization** name.
6. Enter one or more **Bucket** names, or leave blank to back up all buckets.
7. Click **Test Connection** - DBackup will call the `/health` endpoint.
8. Click **Fetch Databases** to list available buckets.
9. Click **Save**.

<details>
<summary>Creating an InfluxDB v2 API Token</summary>

1. Open the InfluxDB UI at `http://your-host:8086`.
2. Go to **Data** → **API Tokens** → **Generate API Token**.
3. Choose **All Access Token** for full backup permissions, or create a custom token with:
   - **Read** access to the target buckets.
   - **Write** access to buckets for restore operations.
4. Copy the token and paste it into DBackup's **API Token** field.

Alternatively, use the CLI:
```bash
influx auth create \
  --org myorg \
  --read-buckets \
  --write-buckets
```

</details>

## How It Works

DBackup runs the native InfluxDB backup command, which writes backup files to a temporary directory on the DBackup server:

- **v1**: `influxd backup -portable -host <host>:<rpcPort> [-database <db>] <tmpDir>`
- **v2**: `influx backup <tmpDir> --host http://<host>:<port> --token <token>`

After the backup completes, all files in the temporary directory are packed into a single TAR archive with a metadata file (`dbackup-meta.json`). This archive is then uploaded to the configured destination, optionally compressed or encrypted by the backup job settings.

For restore, DBackup extracts the TAR archive and runs the corresponding restore command:

- **v1**: `influxd restore -portable -host <host>:<rpcPort> <tmpDir>`
- **v2**: `influx restore <tmpDir> --host http://<host>:<port> --token <token>`

## Troubleshooting

### Connection refused on test

```
Connection failed: fetch failed - ECONNREFUSED
```

**Solution:** Verify the **Host** and **Port** values. Ensure the InfluxDB service is running and reachable from the DBackup server. Check firewall rules.

### RPC port refused (v1 only)

```
influxd exited with code 1: dial tcp: connect: connection refused
```

**Solution:** The v1 `influxd backup` connects to the RPC port (default `8088`), not the HTTP port. Verify `[rpc]` is configured in `/etc/influxdb/influxdb.conf` and not blocked by the firewall:
```ini
[rpc]
  enabled = true
  bind-address = ":8088"
```

### Unauthorized (v1)

```
influxd exited with code 1: authorization failed
```

**Solution:** Authentication is enabled on the InfluxDB v1 instance. Set **Username** and **Password** in the source configuration.

### Token lacks permissions (v2)

```
influx exited with code 1: unauthorized: unauthorized access
```

**Solution:** The API token does not have sufficient permissions. Create a new token with at minimum **read access to all buckets** (or the specific buckets you are backing up).

### influx/influxd not found

```
Failed to start influx: spawn ENOENT
```

**Solution:** The `influx` (v2) or `influxd` (v1) binary is not on the system PATH. Install the InfluxDB tools on the DBackup server - see [Prerequisites](#prerequisites).

## Next Steps

- [Encryption Profiles](/user-guide/security/encryption-profiles) - encrypt backup archives at rest
- [Retention Policies](/user-guide/jobs/retention) - automatically delete old backups
- [Restore](/user-guide/features/restore) - restore a backup to an InfluxDB instance
