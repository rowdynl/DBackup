import { createReadStream } from "fs";
import { extract } from "tar-stream";
import type { InfluxDBBackupMeta } from "./dump";

/**
 * Analyze an InfluxDB backup archive and return the contained database or
 * bucket names. Reads the dbackup-meta.json embedded in the tar archive.
 */
export async function analyzeDump(sourcePath: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
        const extractor = extract();
        let resolved = false;

        extractor.on("entry", (header, stream, next) => {
            if (header.name === "dbackup-meta.json") {
                const chunks: Buffer[] = [];

                stream.on("data", (chunk: Buffer) => chunks.push(chunk));
                stream.on("end", () => {
                    try {
                        const meta = JSON.parse(
                            Buffer.concat(chunks).toString("utf-8")
                        ) as InfluxDBBackupMeta;
                        resolved = true;
                        resolve(meta.databases ?? []);
                    } catch {
                        resolve([]);
                    }
                    next();
                });

                stream.on("error", reject);
            } else {
                stream.resume();
                next();
            }
        });

        extractor.on("finish", () => {
            if (!resolved) resolve([]);
        });

        extractor.on("error", reject);

        createReadStream(sourcePath).pipe(extractor);
    });
}
