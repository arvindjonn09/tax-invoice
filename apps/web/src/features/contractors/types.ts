export type Contractor = {
  id: string;
  name: string;
  abn: string | null;
  email: string | null;
  phone: string | null;
  gstRegistered: boolean;
  userId: string | null;
  archivedAt: string | null;
};
export type Offer = {
  id: string;
  jobId: string;
  scope: string;
  rateType: "fixed" | "hourly";
  rateExclusiveCents: string;
  estimatedHours: string | null;
  taxCode: string;
  status: "offered" | "accepted" | "declined" | "withdrawn";
  exclusiveCents: string | null;
  gstCents: string | null;
  inclusiveCents: string | null;
  responseNote: string | null;
  respondedAt: string | null;
  createdAt: string;
  acceptance: {
    acceptedAt: string;
    committedCostCents: string;
    companyGstRegistered: boolean;
  } | null;
};
