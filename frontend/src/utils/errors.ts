export class ApiError extends Error {
  status?: number;
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong.'
}