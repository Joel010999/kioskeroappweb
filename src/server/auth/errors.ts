export class AuthorizationError extends Error {
  constructor(public readonly code: "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class UnauthenticatedError extends AuthorizationError {
  constructor(message = "Authentication is required.") { super("UNAUTHENTICATED", message); this.name = "UnauthenticatedError"; }
}

export class ForbiddenError extends AuthorizationError {
  constructor(message = "You are not allowed to perform this action.") { super("FORBIDDEN", message); this.name = "ForbiddenError"; }
}

export class NotFoundError extends AuthorizationError {
  constructor(message = "The requested resource was not found.") { super("NOT_FOUND", message); this.name = "NotFoundError"; }
}
