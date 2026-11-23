/**
 * Domain errors that carry an HTTP status and a stable machine-readable code.
 * Services throw these; the API maps them to responses and the CLI prints the
 * message. Anything else is treated as an unexpected 500.
 */
export class AppError extends Error {
	constructor(
		message: string,
		public readonly status = 400,
		public readonly code = "bad_request",
	) {
		super(message);
		this.name = new.target.name;
	}
}

export class ValidationError extends AppError {
	constructor(message: string) {
		super(message, 400, "invalid_input");
	}
}

export class UnauthorizedError extends AppError {
	constructor(message = "Please sign in to continue.") {
		super(message, 401, "unauthorized");
	}
}

export class ForbiddenError extends AppError {
	constructor(message = "You don't have access to this.") {
		super(message, 403, "forbidden");
	}
}

export class NotFoundError extends AppError {
	constructor(message = "Not found") {
		super(message, 404, "not_found");
	}
}

export class ConflictError extends AppError {
	constructor(message: string) {
		super(message, 409, "conflict");
	}
}

export class RateLimitError extends AppError {
	constructor(message = "Too many requests — please slow down.") {
		super(message, 429, "rate_limited");
	}
}

/** The user's plan doesn't allow this; the client should offer an upgrade. */
export class PlanLimitError extends AppError {
	constructor(message: string) {
		super(message, 402, "plan_limit");
	}
}

/** A capability that depends on optional configuration (AI, Qdrant, email, billing). */
export class FeatureUnavailableError extends AppError {
	constructor(feature: string, missing: string[]) {
		super(`${feature} needs ${missing.join(" and ")} — set them in .env (see .env.example).`, 503, "unavailable");
	}
}
