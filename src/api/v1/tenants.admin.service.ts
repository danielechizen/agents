import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  assertTenantCreatable,
  assertTenantUpdatable,
  TENANT_SELECT,
  type TenantCreate,
  type TenantDto,
  type TenantUpdate,
  toDto,
} from "@/api/v1/tenants.service";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { isUniqueViolation } from "@/lib/pg-error";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { auditMutationOn } from "@/modules/audit/service";
import { emitOutbound } from "@/modules/webhooks/outbound/service";

// Fleet tenant mutations. Create and delete run as the fleet role: the tenant policy hides every
// other row from a tenant scope, and a delete's audit row is fleet-level so the cascade keeps it.
// A tenant admin renames only the tenant the request is already scoped to.

async function rename(
  db: ScopedDb,
  ctx: TenantContext,
  id: bigint,
  name: string,
): Promise<TenantDto> {
  const current = await db.tenant.findFirst({
    where: { id },
    select: TENANT_SELECT,
  });
  if (!current) {
    throw new NotFoundError("Tenant not found", "errors.tenantNotFound");
  }
  if (current.name === name) return toDto(current);
  const row = await db.tenant.update({
    where: { id },
    data: { name },
    select: TENANT_SELECT,
  });
  await auditMutationOn(db, ctx, id, {
    action: "tenant.update",
    target: `tenant:${id}`,
    before: { name: current.name },
    after: { name: row.name },
  });
  return toDto(row);
}

export async function updateTenant(
  ctx: TenantContext,
  id: bigint,
  patch: TenantUpdate,
  base: PrismaClient = basePrisma,
): Promise<TenantDto> {
  const parsed = assertTenantUpdatable(patch);
  if (ctx.role === "SUPER_ADMIN") {
    return asSuperAdminOn(base, (db) => rename(db, ctx, id, parsed.name));
  }
  if (ctx.role !== "TENANT_ADMIN" || ctx.tenantId !== id) {
    throw new NotFoundError("Tenant not found", "errors.tenantNotFound");
  }
  return runScopedOn(base, ctx, (db) => rename(db, ctx, id, parsed.name));
}

export async function createTenant(
  ctx: TenantContext,
  input: TenantCreate,
  base: PrismaClient = basePrisma,
): Promise<TenantDto> {
  if (ctx.role !== "SUPER_ADMIN") throw new ForbiddenError();
  const parsed = assertTenantCreatable(input);
  let created: { id: bigint; dto: TenantDto };
  try {
    created = await asSuperAdminOn(base, async (db) => {
      const row = await db.tenant.create({
        data: { name: parsed.name, slug: parsed.slug },
        select: TENANT_SELECT,
      });
      await auditMutationOn(db, ctx, null, {
        action: "tenant.create",
        target: `tenant:${row.id}`,
        after: { name: row.name, slug: row.slug },
      });
      return { id: row.id, dto: toDto(row) };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        "tenant slug already in use",
        "errors.tenantSlugInUse",
        "slug",
      );
    }
    throw err;
  }
  // NOTE: The new tenant has no subscriptions yet. The emit stays on that tenant's scope: the
  // fleet role would see every other tenant's subscriptions.
  try {
    await runScopedOn(base, { ...ctx, tenantId: created.id }, (db) =>
      emitOutbound(db, created.id, "tenant.created", {
        tenantId: created.dto.id,
        slug: created.dto.slug,
      }),
    );
  } catch {
    logger.warn(
      { phase: "tenant.created" },
      "tenant.created event was not queued",
    );
  }
  return created.dto;
}

export async function deleteTenant(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  if (ctx.role !== "SUPER_ADMIN") throw new ForbiddenError();
  await asSuperAdminOn(base, async (db) => {
    const row = await db.tenant.findFirst({
      where: { id },
      select: { id: true, name: true, slug: true },
    });
    if (!row) {
      throw new NotFoundError("Tenant not found", "errors.tenantNotFound");
    }
    await auditMutationOn(db, ctx, null, {
      action: "tenant.delete",
      target: `tenant:${row.id}`,
      before: { name: row.name, slug: row.slug },
    });
    await db.tenant.delete({ where: { id: row.id } });
  });
}
