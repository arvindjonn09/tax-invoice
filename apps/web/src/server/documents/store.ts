import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
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
  private readonly client: S3Client;
  private ready: Promise<void> | undefined;

  constructor(private readonly settings: S3Settings) {
    this.client = new S3Client({
      region: settings.region,
      ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
      forcePathStyle: true,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
    });
  }

  /** Create the private bucket on first use where it doesn't exist (dev/CI). */
  private bucket() {
    this.ready ??= this.client
      .send(new HeadBucketCommand({ Bucket: this.settings.bucket }))
      .then(
        () => undefined,
        () =>
          this.client
            .send(new CreateBucketCommand({ Bucket: this.settings.bucket }))
            .then(() => undefined),
      );
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
