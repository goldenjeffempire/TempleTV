import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const region = process.env.AWS_REGION;
const bucket = process.env.AWS_S3_BUCKET;
const client = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const key = `_smoketest/${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
const body = `temple-tv s3 integration smoketest @ ${new Date().toISOString()}`;

console.log("PUT", `s3://${bucket}/${key}`);
await client.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: "text/plain",
    Metadata: {
      aclpolicy: JSON.stringify({ owner: "smoketest", visibility: "public" }),
    },
  }),
);

console.log("HEAD");
const head = await client.send(
  new HeadObjectCommand({ Bucket: bucket, Key: key }),
);
console.log("  ContentType:", head.ContentType);
console.log("  ContentLength:", head.ContentLength);
console.log("  Metadata:", head.Metadata);

console.log("GET");
const got = await client.send(
  new GetObjectCommand({ Bucket: bucket, Key: key }),
);
const text = await got.Body.transformToString();
console.log("  body matches:", text === body);

console.log("COPY-IN-PLACE (metadata replace)");
await client.send(
  new CopyObjectCommand({
    Bucket: bucket,
    Key: key,
    CopySource: `${bucket}/${encodeURIComponent(key)}`,
    Metadata: {
      aclpolicy: JSON.stringify({ owner: "smoketest", visibility: "private" }),
    },
    MetadataDirective: "REPLACE",
    ContentType: "text/plain",
  }),
);
const head2 = await client.send(
  new HeadObjectCommand({ Bucket: bucket, Key: key }),
);
console.log("  Updated metadata:", head2.Metadata);

console.log("LIST prefix");
const list = await client.send(
  new ListObjectsV2Command({ Bucket: bucket, Prefix: "_smoketest/" }),
);
console.log("  count:", (list.Contents || []).length);

console.log("DELETE");
await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
console.log("  deleted");

console.log(
  "\nAll S3 round-trip operations succeeded against bucket",
  bucket,
  "in",
  region,
);
