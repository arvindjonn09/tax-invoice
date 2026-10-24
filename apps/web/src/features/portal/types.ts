export type OwnOffer = {
  id: string;
  jobId: string;
  scope: string;
  status: "offered" | "accepted" | "declined" | "withdrawn";
  rateType: "fixed" | "hourly";
  rateExclusiveCents: string;
  estimatedHours: string | null;
  taxCode: string;
  exclusiveCents: string | null;
  gstCents: string | null;
  inclusiveCents: string | null;
  contractorActive: boolean;
  responseNote: string | null;
  respondedAt: string | null;
  job: {
    reference: string;
    title: string;
    status: string;
    dueOn: string | null;
  };
  acceptance: {
    acceptedAt: string;
    rateExclusiveCents: string;
    exclusiveCents: string;
    gstCents: string;
    inclusiveCents: string;
  } | null;
};
