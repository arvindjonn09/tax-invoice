import { operatorApi, withOperator } from "@/server/operator";

export const POST = withOperator(operatorApi.decline);
