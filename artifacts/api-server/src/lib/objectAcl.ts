/**
 * Per-object access-control policy stored in S3 user metadata.
 *
 * The policy JSON lives under the `aclpolicy` user-metadata key on every
 * object that has been explicitly secured. S3 normalises user-metadata keys
 * to lowercase and exposes them as `x-amz-meta-aclpolicy`.
 *
 * Note: S3 cannot mutate metadata in place — a self-copy with
 * `MetadataDirective: REPLACE` is required, which is what
 * `replaceObjectMetadata` does internally.
 */

import { headObject, replaceObjectMetadata } from "./s3Storage";

const ACL_POLICY_METADATA_KEY = "aclpolicy";

// Can be flexibly defined according to the use case.
//
// Examples:
// - USER_LIST: the users from a list stored in the database;
// - EMAIL_DOMAIN: the users whose email is in a specific domain;
// - GROUP_MEMBER: the users who are members of a specific group;
// - SUBSCRIBER: the users who are subscribers of a specific service / content
//   creator.
export enum ObjectAccessGroupType {}

export interface ObjectAccessGroup {
  type: ObjectAccessGroupType;
  // The logic id that identifies qualified group members. Format depends on the
  // ObjectAccessGroupType — e.g. a user-list DB id, an email domain, a group id.
  id: string;
}

export enum ObjectPermission {
  READ = "read",
  WRITE = "write",
}

export interface ObjectAclRule {
  group: ObjectAccessGroup;
  permission: ObjectPermission;
}

// Stored as object user metadata under `aclpolicy` (JSON string).
export interface ObjectAclPolicy {
  owner: string;
  visibility: "public" | "private";
  aclRules?: Array<ObjectAclRule>;
}

function isPermissionAllowed(
  requested: ObjectPermission,
  granted: ObjectPermission,
): boolean {
  if (requested === ObjectPermission.READ) {
    return [ObjectPermission.READ, ObjectPermission.WRITE].includes(granted);
  }
  return granted === ObjectPermission.WRITE;
}

abstract class BaseObjectAccessGroup implements ObjectAccessGroup {
  constructor(
    public readonly type: ObjectAccessGroupType,
    public readonly id: string,
  ) {}

  public abstract hasMember(userId: string): Promise<boolean>;
}

function createObjectAccessGroup(
  group: ObjectAccessGroup,
): BaseObjectAccessGroup {
  switch (group.type) {
    // Implement per access group type, e.g.:
    // case "USER_LIST":
    //   return new UserListAccessGroup(group.id);
    default:
      throw new Error(`Unknown access group type: ${group.type}`);
  }
}

export async function setObjectAclPolicy(
  objectKey: string,
  aclPolicy: ObjectAclPolicy,
): Promise<void> {
  const head = await headObject(objectKey);
  if (!head) {
    throw new Error(`Object not found: ${objectKey}`);
  }

  const merged: Record<string, string> = {
    ...head.metadata,
    [ACL_POLICY_METADATA_KEY]: JSON.stringify(aclPolicy),
  };

  await replaceObjectMetadata(objectKey, merged, {
    contentType: head.contentType ?? undefined,
  });
}

export async function getObjectAclPolicy(
  objectKey: string,
): Promise<ObjectAclPolicy | null> {
  const head = await headObject(objectKey);
  if (!head) return null;
  const raw = head.metadata?.[ACL_POLICY_METADATA_KEY];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ObjectAclPolicy;
  } catch {
    return null;
  }
}

export async function canAccessObject({
  userId,
  objectKey,
  requestedPermission,
}: {
  userId?: string;
  objectKey: string;
  requestedPermission: ObjectPermission;
}): Promise<boolean> {
  const aclPolicy = await getObjectAclPolicy(objectKey);
  if (!aclPolicy) {
    return false;
  }

  if (
    aclPolicy.visibility === "public" &&
    requestedPermission === ObjectPermission.READ
  ) {
    return true;
  }

  if (!userId) {
    return false;
  }

  if (aclPolicy.owner === userId) {
    return true;
  }

  for (const rule of aclPolicy.aclRules || []) {
    const accessGroup = createObjectAccessGroup(rule.group);
    if (
      (await accessGroup.hasMember(userId)) &&
      isPermissionAllowed(requestedPermission, rule.permission)
    ) {
      return true;
    }
  }

  return false;
}
