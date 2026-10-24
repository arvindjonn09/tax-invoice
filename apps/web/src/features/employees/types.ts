export type Employee = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  userId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};
/** Append-only internal labour cost; not a price and has no GST. */
export type EmployeeRate = {
  id: string;
  effectiveFrom: string;
  hourlyCostCents: string;
  createdAt: string;
};
export type LinkableUser = {
  userId: string;
  name: string;
  email: string;
  employeeId: string | null;
};
