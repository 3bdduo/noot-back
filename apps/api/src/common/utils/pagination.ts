import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function toPage<T>(items: T[], total: number, p: Pagination): Page<T> {
  return {
    items,
    total,
    page: p.page,
    pageSize: p.pageSize,
    totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
  };
}

export function skipTake(p: Pagination): { skip: number; take: number } {
  return { skip: (p.page - 1) * p.pageSize, take: p.pageSize };
}
