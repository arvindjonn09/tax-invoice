import type { Assignment } from "../../../../../packages/database/src/generated/prisma/client";

export function assignmentView(
  row: Assignment & { employee: { name: string; isActive: boolean } },
) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: row.employee.name,
    employeeActive: row.employee.isActive,
    visitId: row.visitId,
    assignedAt: row.assignedAt,
    endedAt: row.endedAt,
  };
}
