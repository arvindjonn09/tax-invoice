"use client";
export { useRemote } from "@/components/data/use-remote";
export type Customer = {
  id: string;
  name: string;
  abn: string | null;
  billingEmail: string | null;
  billingPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  archivedAt: string | null;
};
export type Contact = {
  id: string;
  name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  archivedAt: string | null;
};
export type Location = {
  id: string;
  label: string | null;
  addressLine1: string;
  addressLine2: string | null;
  suburb: string;
  state: string;
  postcode: string;
  accessNotes: string | null;
  archivedAt: string | null;
};
