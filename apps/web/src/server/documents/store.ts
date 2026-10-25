import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Private object storage (#34). Objects are written and read only by the
 * server: the bucket is never public and browsers never get storage
 * credentials or bucket URLs.
 */
export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** The object's bytes, or null if it doesn't exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Remove an object (compensation when its database row couldn't be saved). */
  delete(key: string): Promise<void>;
  /** Every stored key (backups, #63). */
  keys(): AsyncIterable<string>;
}

/** For tests and local runs without MinIO. Never used when S3 is configured. */
export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array) {
    this.objects.set(key, body);
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async *keys() {
    yield* [...this.objects.keys()];
  }
}

export type S3Settings = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** S3 or an S3-compatible service (MinIO locally/CI), path-style addressing. */
export class S3Store implements ObjectStore {
  private readonly client: Pick<S3Client, "send">;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly settings: S3Settings,
    /** Injected in tests; a real S3Client otherwise. */
    client?: Pick<S3Client, "send">,
  ) {
    this.client =
      client ??
      new S3Client({
        region: settings.region,
        ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
        forcePathStyle: true,
        credentials: {
          accessKeyId: settings.accessKeyId,
          secretAccessKey: settings.secretAccessKey,
        },
      });
  }

  /**
   * Create the private bucket on first use, only when S3 confirms it is
   * missing (dev/CI). Any other failure (network, auth, throttling) is
   * rethrown and NOT cached, so the next request retries.
   */
  private bucket() {
    this.ready ??= (async () => {
      const Bucket = this.settings.bucket;
      try {
        await this.client.send(new HeadBucketCommand({ Bucket }));
      } catch (error) {
        const { name, $metadata } = error as {
          name?: string;
          $metadata?: { httpStatusCode?: number };
        };
        if (name !== "NotFound" && $metadata?.httpStatusCode !== 404)
          throw error;
        await this.client.send(new CreateBucketCommand({ Bucket }));
      }
    })().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    await this.bucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string) {
    await this.bucket();
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }),
      );
      return result.Body ? await result.Body.transformToByteArray() : null;
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey") return null;
      throw error;
    }
  }

  async delete(key: string) {
    await this.bucket();
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: key }),
    );
  }

  async *keys() {
    await this.bucket();
    let ContinuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.settings.bucket,
          ...(ContinuationToken ? { ContinuationToken } : {}),
        }),
      );
      for (const item of page.Contents ?? []) if (item.Key) yield item.Key;
      ContinuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (ContinuationToken);
  }
}

/**
 * Storage from the environment: S3_* when set; otherwise the local MinIO from
 * `pnpm db:env` (MINIO_ROOT_*). Returns null when nothing is configured, so
 * file features report "storage unavailable" instead of failing open.
 */
export function storeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStore | null {
  const bucket = env.S3_BUCKET ?? "jobflow-documents";
  if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)
    return new S3Store({
      bucket,
      region: env.S3_REGION ?? "ap-southeast-2",
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    });
  if (env.MINIO_ROOT_USER && env.MINIO_ROOT_PASSWORD)
    return new S3Store({
      bucket,
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${env.MINIO_API_PORT ?? "9000"}`,
      accessKeyId: env.MINIO_ROOT_USER,
      secretAccessKey: env.MINIO_ROOT_PASSWORD,
    });
  return null;
}
