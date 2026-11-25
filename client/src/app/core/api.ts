import { HttpClient, HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { catchError, firstValueFrom, throwError } from 'rxjs';

/** The workspace this tab is showing; the server refuses requests if another tab has switched away. */
export const activeWorkspace = signal<string | null>(null);

/** Bumped whenever the server says our session is gone. */
export const sessionExpired = signal(0);

export const apiInterceptor: HttpInterceptorFn = (request, next) =>
  next(
    request.url.startsWith('/api')
      ? request.clone({
          setHeaders: {
            'X-Requested-With': 'studio',
            ...(activeWorkspace() ? { 'X-Workspace': activeWorkspace()! } : {}),
          },
        })
      : request,
  ).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        !request.url.startsWith('/api/auth/')
      ) {
        sessionExpired.update((n) => n + 1);
      }
      return throwError(() => error);
    }),
  );

export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as { error?: string } | null;
    if (body && typeof body.error === 'string') return body.error;
    return error.status === 0 || error.status >= 502
      ? 'Cannot reach the server. Check that it is running.'
      : `Request failed (${error.status})`;
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  get<T>(url: string): Promise<T> {
    return firstValueFrom(this.http.get<T>(`/api${url}`));
  }

  post<T>(url: string, body: unknown = {}): Promise<T> {
    return firstValueFrom(this.http.post<T>(`/api${url}`, body));
  }

  put<T>(url: string, body: unknown): Promise<T> {
    return firstValueFrom(this.http.put<T>(`/api${url}`, body));
  }

  /** For deletions that answer with the updated record. */
  send<T>(method: 'delete', url: string): Promise<T> {
    return firstValueFrom(this.http.request<T>(method, `/api${url}`));
  }

  delete(url: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api${url}`));
  }
}
