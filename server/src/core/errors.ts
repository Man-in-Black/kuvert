/** Fehler, der mit HTTP-Status und maschinenlesbarem Code an den Client geht. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Zugangsdaten ungültig/abgelaufen – Konto muss neu verbunden werden. */
export class AuthError extends AppError {
  constructor(message = 'Anmeldung beim Anbieter fehlgeschlagen – bitte Konto neu verbinden', details?: unknown) {
    super(401, 'provider_auth', message, details);
    this.name = 'AuthError';
  }
}

export class NotSupportedError extends AppError {
  constructor(what: string) {
    super(501, 'not_supported', `Nicht unterstützt: ${what}`);
    this.name = 'NotSupportedError';
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Ressource') {
    super(404, 'not_found', `${what} nicht gefunden`);
    this.name = 'NotFoundError';
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'bad_request', message, details);
    this.name = 'BadRequestError';
  }
}

/** Fehler eines entfernten HTTP-APIs (Graph, Google, WebDAV …). */
export class HttpError extends AppError {
  constructor(
    status: number,
    message: string,
    public body?: unknown,
  ) {
    super(status >= 500 ? 502 : status, 'upstream_error', message, body);
    this.name = 'HttpError';
  }
}
