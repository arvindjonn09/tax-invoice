import { operatorApi, withOperator } from "@/server/operator";

export const dynamic = "force-dynamic";
export const GET = withOperator(operatorApi.listRequests);
