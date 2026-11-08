// #229 (S7): the supplier details frozen onto a document when it's issued
// (invoice, credit note) or sent (quote). Version 2 adds the contact details
// and the logo current at that moment; a version 1 snapshot (before M6) has
// only the name, ABN and address and keeps rendering exactly as it did.
import type { Prisma } from "../../../../../packages/database/src/generated/prisma/client";

type Tx = Pick<Prisma.TransactionClient, "document">;

/** Fields of the company row a snapshot copies. */
export type SupplierProfile = {
  id: string;
  name: string;
  legalName: string | null;
  abn: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  businessEmail: string | null;
  website: string | null;
  about: string | null;
  logoDocumentId: string | null;
};

/** The logo a snapshot points at: a private company_logo document. */
export type SnapshotLogo = {
  documentId: string;
  /** Checked when the PDF embeds the bytes, so a changed object is refused. */
  sha256: string;
  contentType: string;
};

export type SupplierSnapshotV2 = {
  v: 2;
  name: string;
  legalName: string | null;
  abn: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  businessEmail: string | null;
  website: string | null;
  logo: SnapshotLogo | null;
  /** Quotes only: the "about us" text current when it was sent. */
  about?: string | null;
};

/**
 * Build the snapshot inside the issuing or sending transaction. The logo is
 * looked up in the same company, as a company_logo document; anything else
 * is ignored (the database already enforces both, this is defence in depth).
 */
export async function supplierSnapshot(
  tx: Tx,
  company: SupplierProfile,
  options: { about?: boolean } = {},
): Promise<SupplierSnapshotV2> {
  const logo = company.logoDocumentId
    ? await tx.document.findFirst({
        where: {
          id: company.logoDocumentId,
          companyId: company.id,
          kind: "company_logo",
        },
        select: { id: true, sha256: true, contentType: true },
      })
    : null;
  return {
    v: 2,
    name: company.name,
    legalName: company.legalName,
    abn: company.abn,
    addressLine1: company.addressLine1,
    addressLine2: company.addressLine2,
    suburb: company.suburb,
    state: company.state,
    postcode: company.postcode,
    phone: company.phone,
    businessEmail: company.businessEmail,
    website: company.website,
    logo: logo
      ? {
          documentId: logo.id,
          sha256: logo.sha256,
          contentType: logo.contentType,
        }
      : null,
    ...(options.about ? { about: company.about } : {}),
  };
}

/** A stored snapshot's logo, if it's a version 2 snapshot that has one. */
export function snapshotLogo(snapshot: unknown): SnapshotLogo | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as { v?: unknown; logo?: unknown };
  if (value.v !== 2 || !value.logo || typeof value.logo !== "object")
    return null;
  const logo = value.logo as Partial<SnapshotLogo>;
  return typeof logo.documentId === "string" &&
    typeof logo.sha256 === "string" &&
    typeof logo.contentType === "string"
    ? {
        documentId: logo.documentId,
        sha256: logo.sha256,
        contentType: logo.contentType,
      }
    : null;
}
